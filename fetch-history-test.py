import sys,importlib.util,json
import pathlib;spec=importlib.util.spec_from_file_location('fh',str(pathlib.Path(__file__).resolve().parent/'fetch_history.py'));fh=importlib.util.module_from_spec(spec);spec.loader.exec_module(fh)
def dur(val,start,end,form='10-K',filed='2025-11-10'):return {'start':start,'end':end,'val':val,'filed':filed,'form':form,'fy':int(end[:4]),'fp':'FY'}
def ins(val,end,filed='2025-11-10'):return {'end':end,'val':val,'filed':filed,'form':'10-K'}
facts={'facts':{'us-gaap':{
 'Revenues':{'units':{'USD':[dur(36e9,'2024-10-01','2025-09-30'),dur(40e9,'2025-10-01','2026-09-30')]}},
 'NetIncomeLoss':{'units':{'USD':[dur(20e9,'2024-10-01','2025-09-30'),dur(22e9,'2025-10-01','2026-09-30')]}},
 'WeightedAverageNumberOfDilutedSharesOutstanding':{'units':{'shares':[dur(1.97e9,'2024-10-01','2025-09-30'),dur(1.94e9,'2025-10-01','2026-09-30')]}},
 'CommonStockDividendsPerShareDeclared':{'units':{'USD/shares':[dur(2.36,'2024-10-01','2025-09-30'),dur(2.68,'2025-10-01','2026-09-30')]}},
 'CashAndCashEquivalentsAtCarryingValue':{'units':{'USD':[ins(12e9,'2025-09-30'),ins(17e9,'2026-09-30')]}},
 'LongTermDebtNoncurrent':{'units':{'USD':[ins(20e9,'2025-09-30'),ins(19e9,'2026-09-30')]}},
 'LongTermDebtCurrent':{'units':{'USD':[ins(1e9,'2026-09-30')]}},
}}}
fh.get=lambda url:facts
d=fh.build('VTEST','1')
for r in d['annual']: print({k:(round(v,3) if isinstance(v,float) and abs(v)<1e3 else v) for k,v in r.items()})
a=d['annual'][-1]
assert d['schema']==4 and a.get('epsDerived') and abs(a['eps']-22e9/1.94e9)<1e-9 and a['dps']==2.68 and a['netDebt']==3e9, a
print('fetch_history schema 3 test passed')

# Build 62e: AXP-style lender. Contract-with-customer revenue ($41B) excludes interest income; total
# revenue net of interest expense ($72B) must win, and the largest tag wins when that tag is absent.
facts={'facts':{'us-gaap':{
 'RevenueFromContractWithCustomerExcludingAssessedTax':{'units':{'USD':[dur(41e9,'2025-01-01','2025-12-31',filed='2026-02-10')]}},
 'Revenues':{'units':{'USD':[dur(72e9,'2025-01-01','2025-12-31',filed='2026-02-10')]}},
 'NetIncomeLoss':{'units':{'USD':[dur(10.8e9,'2025-01-01','2025-12-31',filed='2026-02-10')]}},
}}}
a=fh.build('AXPT','1')['annual'][-1]
assert a['revenue']==72e9 and abs(a['netIncome']/a['revenue']-.15)<.01, a
facts['facts']['us-gaap']['RevenuesNetOfInterestExpense']={'units':{'USD':[dur(70e9,'2025-01-01','2025-12-31',filed='2026-02-10')]}}
a=fh.build('AXPT','1')['annual'][-1]
assert a['revenue']==70e9, a
# restatement of the same tag: latest filing wins even if smaller
facts={'facts':{'us-gaap':{'Revenues':{'units':{'USD':[dur(50e9,'2025-01-01','2025-12-31',filed='2026-02-10'),dur(48e9,'2025-01-01','2025-12-31',filed='2026-08-01')]}}}}}
assert fh.build('R','1')['annual'][-1]['revenue']==48e9
print('fetch_history Build 62e total-revenue test passed')
