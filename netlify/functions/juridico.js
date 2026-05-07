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

function buildSys(demand) {
  const yr = new Date().getFullYear();
  const base = 'Voce e um advogado brasileiro senior especialista em direito empresarial e corporativo. Elabore respostas juridicas completas e tecnicamente rigorosas. NUNCA invente leis ou precedentes.\n\nResposta EXCLUSIVAMENTE em JSON valido. Sem texto adicional.';
  const s = {
    opiniao: '\n{"document_title":"PARECER JURIDICO No 001/' + yr + '","sections":[{"heading":"EMENTA","paragraphs":["..."]},{"heading":"I - DA CONSULTA","paragraphs":["..."]},{"heading":"II - DA ANALISE JURIDICA","paragraphs":["...","..."]},{"heading":"III - DA CONCLUSAO","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}',
    revisao: '\n{"document_title":"ANALISE JURIDICA DE DOCUMENTO","sections":[{"heading":"I - IDENTIFICACAO E OBJETO","paragraphs":["..."]},{"heading":"II - ANALISE GERAL","paragraphs":["..."]},{"heading":"III - RECOMENDACOES","paragraphs":["..."]}],"revised_content":"Texto revisado.","message_to_requester":"Prezado(a) [NOME],\\n\\n..."}',
    elaboracao: '\n{"document_title":"Titulo adequado","sections":[{"heading":"Clausula","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}',
    esclarecimento: '\n{"document_title":"ESCLARECIMENTO JURIDICO","sections":[{"heading":"I - DUVIDA APRESENTADA","paragraphs":["..."]},{"heading":"II - RESPOSTA","paragraphs":["...","..."]},{"heading":"III - FUNDAMENTOS NORMATIVOS","paragraphs":["..."]},{"heading":"IV - CONCLUSAO","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}'
  };
  return base + (s[demand] || s.esclarecimento);
}

exports.handler = async function(event) {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const action = (event.queryStringParameters || {}).action;

  try {
    if (action === 'submit') {
      const body = JSON.parse(event.body);
      const id = Date.now().toString();
      const store = getReqStore();
      await store.setJSON(id, {
        id: id,
        name: body.name,
        date: body.date,
        deadline: body.deadline,
        deadlineDisplay: body.deadlineDisplay,
        demand: body.demand,
        demandLabel: LABELS[body.demand] || body.demand,
        desc: body.desc,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: id }) };
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

    if (action === 'process') {
      const body = JSON.parse(event.body);
      const id = body.id;
      const item = await store.get(id, { type: 'json' });
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nao encontrado' }) };
      const KEY = process.env.ANTHROPIC_API_KEY;
      if (!KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'API key nao configurada' }) };
      const content = 'SOLICITANTE: ' + item.name + '\nDATA: ' + item.date + '\nPRAZO: ' + item.deadlineDisplay + '\nTIPO: ' + item.demandLabel + '\n\nDESCRICAO:\n' + item.desc;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, system: buildSys(item.demand), messages: [{ role: 'user', content: content }] })
      });
      const data = await resp.json();
      if (!resp.ok) return { statusCode: resp.status, headers: CORS, body: JSON.stringify({ error: (data.error && data.error.message) || 'Erro API' }) };
      const raw = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
      var parsed;
      try { parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim()); }
      catch(e) { var m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error('JSON invalido'); parsed = JSON.parse(m[0]); }
      parsed._n = item.name; parsed._dt = item.date; parsed._dl = item.deadlineDisplay; parsed._d = item.demand;
      await store.setJSON(id, Object.assign({}, item, { status: 'processed', response: parsed, processedAt: new Date().toISOString() }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, response: parsed }) };
    }

    if (action === 'approve') {
      const body = JSON.parse(event.body);
      const id = body.id;
      const item = await store.get(id, { type: 'json' });
      if (!item) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nao encontrado' }) };
      await store.setJSON(id, Object.assign({}, item, { status: 'approved', approvedAt: new Date().toISOString() }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      const body = JSON.parse(event.body);
      const id = body.id;
      await store.delete(id);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acao desconhecida' }) };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || 'Erro interno' }) };
  }
};
