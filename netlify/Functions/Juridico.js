const { getStore } = require('@netlify/blobs');

const ADMIN_PASSWORD = 'Jur1$@ut0';
const LABELS = {
  opiniao: 'Opinião jurídica',
  revisao: 'Revisão de documento',
  elaboracao: 'Elaboração de documento',
  esclarecimento: 'Esclarecimento de dúvida'
};

function buildSys(demand) {
  const yr = new Date().getFullYear();
  const base = `Você é um advogado brasileiro sênior especialista em direito empresarial e corporativo. Elabore respostas jurídicas completas e tecnicamente rigorosas. NUNCA invente leis ou precedentes — cite apenas normas que você tem certeza que existem.\n\nINSTRUÇÃO CRÍTICA: Responda EXCLUSIVAMENTE com JSON válido. Sem texto adicional, sem markdown.`;
  const s = {
    opiniao: `\nTipo: PARECER JURÍDICO conciso (máx 600 palavras no corpo)\n{"document_title":"PARECER JURÍDICO Nº 001/${yr}","sections":[{"heading":"EMENTA","paragraphs":["..."]},{"heading":"I – DA CONSULTA","paragraphs":["..."]},{"heading":"II – DA ANÁLISE JURÍDICA","paragraphs":["...","..."]},{"heading":"III – DA CONCLUSÃO","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}`,
    revisao: `\nTipo: REVISÃO DE DOCUMENTO\n{"document_title":"ANÁLISE JURÍDICA DE DOCUMENTO","sections":[{"heading":"I – IDENTIFICAÇÃO E OBJETO","paragraphs":["..."]},{"heading":"II – ANÁLISE GERAL","paragraphs":["..."]},{"heading":"III – RECOMENDAÇÕES","paragraphs":["..."]}],"revised_content":"Texto revisado. Use [[DEL:excluído:DEL]] e [[INS:inserido:INS]].","message_to_requester":"Prezado(a) [NOME],\\n\\n..."}`,
    elaboracao: `\nTipo: ELABORAÇÃO DE DOCUMENTO completo\n{"document_title":"Título adequado","sections":[{"heading":"Título da cláusula","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}`,
    esclarecimento: `\nTipo: ESCLARECIMENTO JURÍDICO conciso (máx 600 palavras no corpo)\n{"document_title":"ESCLARECIMENTO JURÍDICO","sections":[{"heading":"I – DÚVIDA APRESENTADA","paragraphs":["..."]},{"heading":"II – RESPOSTA","paragraphs":["...","..."]},{"heading":"III – FUNDAMENTOS NORMATIVOS","paragraphs":["..."]},{"heading":"IV – CONCLUSÃO","paragraphs":["..."]}],"message_to_requester":"Prezado(a) [NOME],\\n\\n..."}`
  };
  return base + s[demand];
}

exports.handler = async function(event) {
  const action = (event.queryStringParameters || {}).action;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const store = getStore('requests');

  // PUBLIC: submit a new request
  if (action === 'submit') {
    try {
      const body = JSON.parse(event.body);
      const id = Date.now().toString();
      await store.setJSON(id, {
        id,
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
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // All other actions require admin password
  const adminPwd = event.headers['x-admin-password'];
  if (adminPwd !== ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Senha incorreta' }) };
  }

  // ADMIN: list all requests ordered by deadline
  if (action === 'list') {
    try {
      const { blobs } = await store.list();
      const items = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
      const valid = items.filter(Boolean);
      valid.sort((a, b) => {
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.localeCompare(b.deadline);
      });
      return { statusCode: 200, headers, body: JSON.stringify(valid) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ADMIN: process a request with Claude
  if (action === 'process') {
    try {
      const { id } = JSON.parse(event.body);
      const item = await store.get(id, { type: 'json' });
      if (!item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Solicitação não encontrada' }) };

      const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key não configurada' }) };

      const content = `SOLICITANTE: ${item.name}\nDATA DA SOLICITAÇÃO: ${item.date}\nPRAZO SOLICITADO: ${item.deadlineDisplay}\nTIPO: ${item.demandLabel}\n\nDESCRIÇÃO:\n${item.desc}`;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: buildSys(item.demand),
          messages: [{ role: 'user', content }]
        })
      });

      const data = await resp.json();
      if (!resp.ok) return { statusCode: resp.status, headers, body: JSON.stringify({ error: data.error?.message || 'Erro na API' }) };

      const raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      let parsed;
      try {
        parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Erro ao interpretar resposta da IA');
        parsed = JSON.parse(m[0]);
      }

      parsed._n = item.name;
      parsed._dt = item.date;
      parsed._dl = item.deadlineDisplay;
      parsed._d = item.demand;

      await store.setJSON(id, { ...item, status: 'processed', response: parsed, processedAt: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: parsed }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ADMIN: approve a request
  if (action === 'approve') {
    try {
      const { id } = JSON.parse(event.body);
      const item = await store.get(id, { type: 'json' });
      if (!item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Não encontrado' }) };
      await store.setJSON(id, { ...item, status: 'approved', approvedAt: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ADMIN: delete a request
  if (action === 'delete') {
    try {
      const { id } = JSON.parse(event.body);
      await store.delete(id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ação desconhecida' }) };
};