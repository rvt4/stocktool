"""Incrementally cache SEC Company Facts into per-ticker history files for GitHub Pages."""
import os, json, time, datetime, pathlib, urllib.request, gzip
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/'data'/'history';OUT.mkdir(parents=True,exist_ok=True)
UA=os.getenv('SEC_USER_AGENT','Stock Research Studio research-contact example@example.com')
HEAD={'User-Agent':UA,'Accept-Encoding':'gzip, deflate','Accept':'application/json'}
def get(url):
    req=urllib.request.Request(url,headers=HEAD)
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = r.read()
        encoding = r.headers.get('Content-Encoding', '').lower()
        if 'gzip' in encoding or payload.startswith(b'\x1f\x8b'):
            payload = gzip.decompress(payload)
        return json.loads(payload.decode('utf-8'))
def records(facts,tags,unit):
    for tag in tags:
        vals=facts.get('us-gaap',{}).get(tag,{}).get('units',{}).get(unit,[])
        if vals:return vals
    return []
TAGS={'revenue':['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax'], 'grossProfit':['GrossProfit'], 'operatingIncome':['OperatingIncomeLoss'], 'netIncome':['NetIncomeLoss','ProfitLoss'], 'eps':['EarningsPerShareDiluted'], 'ocf':['NetCashProvidedByUsedInOperatingActivities'], 'capex':['PaymentsToAcquirePropertyPlantAndEquipment'], 'sbc':['ShareBasedCompensation'], 'shares':['WeightedAverageNumberOfDilutedSharesOutstanding']}
FLOW={'revenue','grossProfit','operatingIncome','netIncome','eps','ocf','capex','sbc'}
def yearquarter(date):
    d=datetime.date.fromisoformat(date);return (d.year-1 if d.month<=3 else d.year), (4 if d.month<=3 else (d.month-1)//3)
def build(ticker,cik):
    facts=get(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{int(cik):010d}.json')['facts'];annual={};qtr={};ytd={}
    for key,tags in TAGS.items():
        unit='USD/shares' if key=='eps' else 'shares' if key=='shares' else 'USD'
        vals=records(facts,tags,unit)
        for r in vals:
            if not all(k in r for k in ('start','end','val','filed')):continue
            try: days=(datetime.date.fromisoformat(r['end'])-datetime.date.fromisoformat(r['start'])).days
            except ValueError:continue
            if r['filed']>datetime.date.today().isoformat():continue
            fy=r.get('fy');fp=r.get('fp');form=r.get('form','')
            if form not in ('10-K','10-Q','10-K/A','10-Q/A'):continue
            if 330<=days<=380 and form.startswith('10-K'):
                label=r['end'][:4];bucket=annual.setdefault(label,{})
                prev=bucket.get(key)
                if not prev or r['filed']>prev[1]:bucket[key]=(r['val'],r['filed'])
            if 65<=days<=105:
                label=r['end'][:7];bucket=qtr.setdefault(label,{})
                prev=bucket.get(key)
                if not prev or r['filed']>prev[1]:bucket[key]=(r['val'],r['filed'])
            if key in ('ocf','capex','sbc') and 150<=days<=295:
                label=r['end'][:7];bucket=ytd.setdefault(label,{})
                prev=bucket.get(key)
                if not prev or r['filed']>prev[1]:bucket[key]=(r['val'],r['filed'])
    def unpack(items):return {k:v[0] for k,v in items.items()}
    ann=[{'period':p,**unpack(v)} for p,v in sorted(annual.items())][-12:]
    quarter=[{'period':p,**unpack(v)} for p,v in sorted(qtr.items())][-28:]
    # SEC cash flow often reports cumulative YTD; recover standalone quarters from same-year cumulative figures.
    for key in ('ocf','capex','sbc'):
        cumul={}
        for label,b in ytd.items():
            if key in b:cumul[label]=b[key][0]
        for a in ann:
            if key in a:cumul[a['period']+'-12']=a[key]
        for row in quarter:
            if key in row:continue
            p=row['period'];y=int(p[:4]);m=int(p[5:]);previous=f'{y}-{m-3:02d}' if m>3 else None
            if p in cumul and (m<=3 or previous in cumul):row[key]=cumul[p]-(cumul[previous] if previous else 0)
    for row in ann+quarter:
        if 'ocf' in row and 'capex' in row:row['fcf']=row['ocf']-row['capex']
    return {'ticker':ticker,'cik':cik,'generatedAt':datetime.date.today().isoformat(),'annual':ann,'quarterly':quarter}
def main():
    data=get('https://www.sec.gov/files/company_tickers.json');mapping={x['ticker'].upper():x['cik_str'] for x in data.values()}
    result=ROOT/'data'/'results.json'
    if not result.exists():raise SystemExit('data/results.json missing')
    obj=json.loads(result.read_text());arr=obj if isinstance(obj,list) else next((obj[k] for k in ('stocks','results','companies','data') if isinstance(obj.get(k),list)),[])
    tickers=sorted({s['ticker'].upper() for s in arr if isinstance(s,dict) and s.get('ticker')})
    limit=int(os.getenv('HISTORY_LIMIT','100'));done=0
    for ticker in tickers:
        if done>=limit:break
        path=OUT/(ticker+'.json')
        if path.exists() and (datetime.date.today()-datetime.date.fromtimestamp(path.stat().st_mtime)).days<30:continue
        cik=mapping.get(ticker) or mapping.get(ticker.replace('.','-'))
        if not cik:continue
        try:
            path.write_text(json.dumps(build(ticker,cik),separators=(',',':')))
            print('History',ticker);done+=1
        except Exception as e:print('History failed',ticker,str(e)[:180])
        time.sleep(.15)
    print('Updated',done,'company histories')
if __name__=='__main__':main()
