const BALANCE_URL = 'https://api.deepseek.com/user/balance';

async function fetchDeepSeekBalance(apiKey, fetchImpl) {
  if (!apiKey) throw new Error('请先在设置中配置 DeepSeek API 密钥。');
  const response = await fetchImpl(BALANCE_URL, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `余额查询失败（${response.status}）`);
  if (typeof body.is_available !== 'boolean' || !Array.isArray(body.balance_infos)) throw new Error('余额接口返回的数据格式不正确。');
  return { is_available: body.is_available, balance_infos: body.balance_infos.map(item => ({ currency: String(item.currency ?? ''), total_balance: String(item.total_balance ?? ''), granted_balance: String(item.granted_balance ?? ''), topped_up_balance: String(item.topped_up_balance ?? '') })) };
}

module.exports = { BALANCE_URL, fetchDeepSeekBalance };
