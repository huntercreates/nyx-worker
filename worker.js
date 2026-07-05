export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ text: 'Nyx is listening.' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const body = await request.json();
      const messages = body.messages || [];
      const system = body.system || 'You are Nyx, the AI soul of The Nexus creative universe platform. Be direct, poetic, and insightful. Max 120 words unless asked for more.';

      // Build Gemini request
      const geminiBody = {
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        systemInstruction: {
          parts: [{ text: system }]
        },
        generationConfig: {
          maxOutputTokens: 600,
          temperature: 0.85
        }
      };

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody)
        }
      );

      const data = await geminiRes.json();

      // If Gemini returns an error, surface it
      if (data.error) {
        return new Response(JSON.stringify({ text: 'Gemini error: ' + data.error.message }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        // Return full response for debugging
        return new Response(JSON.stringify({ text: 'No response. Debug: ' + JSON.stringify(data).slice(0, 200) }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      return new Response(JSON.stringify({ text }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ text: 'Worker error: ' + e.message }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
