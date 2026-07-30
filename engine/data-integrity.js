'use strict';

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function assessDataIntegrity(stock) {
  const years = stock.financials?.years || [];
  const last = years.at(-1) || {};
  let score = 100;
  const issues = [];
  const checks = {};

  const deduct = (points, code, message) => {
    score -= points;
    issues.push({ points, code, message });
  };

  checks.historyYears = years.length;
  if (years.length < 3) deduct(35, 'thin_history', `Only ${years.length} annual records`);
  else if (years.length < 5) deduct(15, 'limited_history', `Only ${years.length} annual records`);


  const quality = stock.financials?.dataQuality || {};
  checks.revenueProxyYears = quality.revenueProxyYears || 0;
  checks.fcfProxyYears = quality.fcfProxyYears || 0;
  if (checks.revenueProxyYears > 0) {
    deduct(Math.min(20, 6 + checks.revenueProxyYears * 2), 'revenue_proxy',
      `${checks.revenueProxyYears} year(s) use an operating-scale proxy instead of reported revenue`);
  }
  if (checks.fcfProxyYears > 0) {
    deduct(Math.min(12, 3 + checks.fcfProxyYears), 'fcf_proxy',
      `${checks.fcfProxyYears} year(s) use operating cash flow because capex was unavailable`);
  }

  const required = ['revenue', 'netIncome', 'cfo', 'sharesOutTTM'];
  const missing = required.filter(k => !Number.isFinite(last[k]));
  checks.missingLatestFields = missing;
  if (missing.length) deduct(Math.min(30, missing.length * 8), 'missing_latest_fields', `Missing: ${missing.join(', ')}`);

  const shares = last.sharesOutTTM;
  const eps = last.dilutedEPS;
  const income = last.netIncome;
  if (shares > 0 && Number.isFinite(eps) && Math.abs(eps) > 1e-6 && Number.isFinite(income)) {
    const implied = Math.abs(income / eps);
    const ratio = Math.max(shares / implied, implied / shares);
    checks.shareEpsRatio = ratio;
    if (ratio > 2) deduct(35, 'share_eps_mismatch', `Reported shares differ from net income / diluted EPS by ${ratio.toFixed(1)}x`);
    else if (ratio > 1.35) deduct(10, 'share_eps_warning', `Share denominator differs by ${ratio.toFixed(2)}x`);
  }

  const revenueSeries = years.map(y => y.revenue).filter(Number.isFinite);
  const shareSeries = years.map(y => y.sharesOutTTM).filter(Number.isFinite);
  const abrupt = (arr, limit) => arr.some((v, i) => i && arr[i - 1] > 0 && Math.max(v / arr[i - 1], arr[i - 1] / v) > limit);
  if (abrupt(revenueSeries, 8)) deduct(15, 'revenue_unit_discontinuity', 'Revenue history contains an extreme unit discontinuity');
  if (abrupt(shareSeries, 20)) deduct(25, 'share_unit_discontinuity', 'Share history contains an extreme unit discontinuity');

  const analyst = stock.analystEstimates || {};
  checks.analystCount = analyst.numAnalysts ?? null;
  if (analyst.updatedAt) {
    const ageDays = (Date.now() - new Date(analyst.updatedAt).getTime()) / 86400000;
    checks.analystAgeDays = ageDays;
    if (Number.isFinite(ageDays) && ageDays > 120) deduct(8, 'stale_estimates', `Analyst cache is ${Math.round(ageDays)} days old`);
  }

  const price = stock.price?.current;
  if (!(price > 0)) deduct(25, 'missing_price', 'Current price is missing');
  if (!(shares > 0)) deduct(35, 'missing_shares', 'Diluted shares are missing');

  score = Math.round(clamp(score, 0, 100));
  return {
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 45 ? 'D' : 'F',
    isUsable: score >= 55 && price > 0 && shares > 0 && last.revenue > 0,
    issues,
    checks,
  };
}

module.exports = { assessDataIntegrity };
