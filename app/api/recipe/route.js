export async function POST(request) {
    const { ingredients } = await request.json();
  
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer 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'
      },
      body: JSON.stringify({
        model: 'openai/gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: `عندي المكونات التالية: ${ingredients}. اقترح علي وصفة سهلة وسريعة.`
          }
        ]
      })
    });
  
    const data = await response.json();
    console.log('رد OpenRouter:', JSON.stringify(data, null, 2));
    return Response.json(data);
  }
  