export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {headers: {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
    }
    try {
      const body = await request.json();
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:body.messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),systemInstruction:{parts:[{text:body.system||'You are Nyx.'}]},generationConfig:{maxOutputTokens:600}})});
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text||'...';
      return new Response(JSON.stringify({text}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
    } catch(e) {
      return new Response(JSON.stringify({text:'Error: '+e.message}),{headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
    }
  }
};
