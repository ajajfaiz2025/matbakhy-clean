export async function POST(request) {
  const { ingredients } = await request.json();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'OPENROUTER_API_KEY is not configured on the server.' },
      { status: 500 }
    );
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
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
  return Response.json(data);
}
