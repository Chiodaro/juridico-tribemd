const { getStore } = require('@netlify/blobs');

const ADMIN_PASSWORD = 'Jur1$@ut0';
const SITE_ID = 'ef3bb316-0dc8-409d-b2d9-1f8210f5637b';
const LABELS = {
  opiniao: 'Opiniao juridica',
  revisao: 'Revisao de documento',
  elaboracao: 'Elaboracao de documento',
  esclarecimento: 'Esclarecimento de duvida'
};

function getReqStore() {
  return getStore({ name: 'requests', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
}

exports.handler = async function(event) {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const action = (event.queryStringParameters || {}).action;
  try {
    if (action === 'submit') {
      const body = JSON.parse(event.body);
      const id = Date.now().toString();
      const store = getReqStore();
      await store.setJSON(id, {
        id: id, name: body.name, date: body.date,
        deadline: body.deadline, deadlineDisplay: body.deadlineDisplay,
        demand: body.demand, demandLabel: LABELS[body.demand] || body.demand,
        desc: body.desc, status: 'pending', createdAt: new Date().toISOString()
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: id, key: process.env.ANTHROPIC_API_KEY }) };
    }

    if (action === 'savepublic') {
      const body = JSON.parse(event.body);
      const store = getReqStore();
      const item = await store.get(body.id, { type: 'json' });
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nao encontrado' }) };
      await store.setJSON(body.id, Object.assign({}, item, { status: 'processed', response: body.response, processedAt: new Date().toISOString() }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    const adminPwd = event.headers['x-admin-password'];
    if (adminPwd !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Senha incorreta' }) };
    }
    const store = getReqStore();

    if (action === 'list') {
      const result = await store.list();
      const items = await Promise.all(result.blobs.map(function(b) { return store.get(b.key, { type: 'json' }); }));
      const valid = items.filter(Boolean);
      valid.sort(function(a, b) {
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify(valid) };
    }

    if (action === 'approve') {
      const body = JSON.parse(event.body);
      const item = await store.get(body.id, { type: 'json' });
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nao encontrado' }) };
      await store.setJSON(body.id, Object.assign({}, item, { status: 'approved', approvedAt: new Date().toISOString() }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      const body = JSON.parse(event.body);
      await store.delete(body.id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acao desconhecida' }) };
  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Erro interno' }) };
  }
};
