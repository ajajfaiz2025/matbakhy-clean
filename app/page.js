'use client';
import { useState } from 'react';

export default function Home() {
  const [ingredients, setIngredients] = useState('');
  const [recipe, setRecipe] = useState('');
  const [loading, setLoading] = useState(false);

  const getRecipe = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredients })
      });
      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content;
      setRecipe(answer || 'ما فيه وصفة حالياً.');
    } catch (err) {
      setRecipe('صار فيه خطأ، حاول مرة ثانية.');
    }
    setLoading(false);
  };

  return (
    <main style={{ padding: 20, fontFamily: 'Arial' }}>
      <h1>مطبخي - بوت الوصفات الذكي</h1>
      <input
        type="text"
        placeholder="اكتب المكونات"
        value={ingredients}
        onChange={(e) => setIngredients(e.target.value)}
        style={{ padding: 10, width: 300 }}
      />
      <button
        onClick={getRecipe}
        style={{ marginLeft: 10, padding: 10 }}
        disabled={loading}
      >
        {loading ? 'يطبخ لك...' : 'اعرض وصفة'}
      </button>
      {recipe && (
        <div style={{ marginTop: 20, whiteSpace: 'pre-wrap' }}>
          {recipe}
        </div>
      )}
    </main>
  );
}
