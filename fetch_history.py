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
    # Build 43: merge ALL listed tags instead of stopping at the first one with data. Each value
    # carries its tag's priority (_p, lower = preferred) so a preferred tag still wins any period
    # it covers, while older/newer years reported under another tag are no longer dropped.
    out=[]
    for i,tag in enumerate(tags):
        for v in facts.get('us-gaap',{}).get(tag,{}).get('units',{}).get(unit,[]):
            out.append({**v,'_p':i})
    return out
TAGS={'revenue':['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax'], 'grossProfit':['GrossProfit'], 'operatingIncome':['OperatingIncomeLoss'], 'netIncome':['NetIncomeLoss','ProfitLoss'], 'eps':['EarningsPerShareDiluted'], 'ocf':['NetCashProvidedByUsedInOperatingActivities'], 'capex':['PaymentsToAcquirePropertyPlantAndEquipment','PaymentsToAcquireProductiveAssets','PaymentsToAcquireOilAndGasPropertyAndEquipment','PaymentsToExploreAndDevelopOilAndGasProperties'], 'sbc':['ShareBasedCompensation'], 'shares':['WeightedAverageNumberOfDilutedSharesOutstanding']}
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
                if not prev or r['_p']<prev[2] or (r['_p']==prev[2] and r['filed']>prev[1]):bucket[key]=(r['val'],r['filed'],r['_p'])
            if 65<=days<=105:
                label=r['end'][:7];bucket=qtr.setdefault(label,{})
                prev=bucket.get(key)
                if not prev or r['_p']<prev[2] or (r['_p']==prev[2] and r['filed']>prev[1]):bucket[key]=(r['val'],r['filed'],r['_p'])
            if key in ('ocf','capex','sbc') and 150<=days<=295:
                label=r['end'][:7];bucket=ytd.setdefault(label,{})
                prev=bucket.get(key)
                if not prev or r['_p']<prev[2] or (r['_p']==prev[2] and r['filed']>prev[1]):bucket[key]=(r['val'],r['filed'],r['_p'])
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
    return {'ticker':ticker,'cik':cik,'schema':2,'generatedAt':datetime.date.today().isoformat(),'annual':ann,'quarterly':quarter}
def main():
    data=get('https://www.sec.gov/files/company_tickers.json');mapping={x['ticker'].upper():x['cik_str'] for x in data.values()}
    result=ROOT/'data'/'results.json'
    if not result.exists():raise SystemExit('data/results.json missing')
    obj=json.loads(result.read_text());arr=obj if isinstance(obj,list) else next((obj[k] for k in ('stocks','results','companies','data') if isinstance(obj.get(k),list)),[])
    tickers=sorted({s['ticker'].upper() for s in arr if isinstance(s,dict) and s.get('ticker')})
    limit=int(os.getenv('HISTORY_LIMIT','100'));done=0
    # Build 43: age comes from the file's own generatedAt (or schema), NOT file mtime. A GitHub Actions
    # checkout stamps every file with "now", so mtime made every cached history look fresh forever.
    SCHEMA=2
    def cached(t):
        path=OUT/(t+'.json')
        if not path.exists():return None
        try:
            d=json.loads(path.read_text());return (int(d.get('schema',1)),datetime.date.fromisoformat(str(d.get('generatedAt'))[:10]))
        except Exception:return (0,datetime.date(1970,1,1))
    info={t:cached(t) for t in tickers}
    def stale(t):
        c=info[t];return c is None or c[0]<SCHEMA or (datetime.date.today()-c[1]).days>=30 or os.getenv('HISTORY_FORCE')=='1'
    # Missing first, then old-schema, then oldest. This avoids alphabetical starvation.
    tickers.sort(key=lambda t:(info[t] is not None, info[t][0]>=SCHEMA if info[t] else False, info[t][1] if info[t] else datetime.date(1970,1,1), t))
    priority=[t.strip().upper() for t in os.getenv('HISTORY_TICKERS','').split(',') if t.strip()]
    tickers=list(dict.fromkeys(priority+tickers))
    for ticker in tickers:
        if done>=limit:break
        path=OUT/(ticker+'.json')
        if t_ok:=(ticker in info and not stale(ticker)):continue
        cik=mapping.get(ticker) or mapping.get(ticker.replace('.','-'))
        if not cik:continue
        try:
            path.write_text(json.dumps(build(ticker,cik),separators=(',',':')))
            print('History',ticker);done+=1
        except Exception as e:print('History failed',ticker,str(e)[:180])
        time.sleep(.15)
    print('Updated',done,'company histories')
if __name__=='__main__':main()
