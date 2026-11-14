import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  followUps?: string[];
}

const STARTERS: Record<'en' | 'fr', string[]> = {
  en: ['What is my ideal temperature?', "What is tonight's plan?", 'What do you recommend?', 'How much have I saved?', 'How does it learn?'],
  fr: ['Quelle est ma température idéale ?', 'Quel est le plan pour ce soir ?', 'Que recommandez-vous ?', "Combien ai-je économisé ?", 'Comment le système apprend-il ?'],
};

export function Assistant() {
  const { state, t } = useApp();
  const [who, setWho] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const sleeper = state?.sleepers.find((s) => s.id === who) ?? state?.sleepers[0];

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, waiting]);
  if (!state || !sleeper) return null;

  const ask = (question: string): void => {
    const q = question.trim();
    if (!q || waiting) return;
    setTurns((list) => [...list, { role: 'user', text: q }]);
    setText('');
    setWaiting(true);
    api
      .ask(sleeper.id, q)
      .then((reply) => setTurns((list) => [...list, { role: 'assistant', text: reply.text, followUps: reply.followUps }]))
      .catch((err: Error) => setTurns((list) => [...list, { role: 'assistant', text: err.message }]))
      .finally(() => setWaiting(false));
  };
  const last = turns[turns.length - 1];
  const chips = last?.role === 'assistant' && last.followUps?.length ? last.followUps : STARTERS[sleeper.locale];

  return (
    <div className="stack">
      <header className="strip">
        <div>
          <h1>{t('assistant.title')}</h1>
          <p className="muted">{t('assistant.intro')}</p>
        </div>
        {state.sleepers.length > 1 && (
          <label>
            <span className="sr">{t('assistant.who')}</span>
            <select
              value={sleeper.id}
              onChange={(e) => {
                setWho(e.target.value);
                setTurns([]);
              }}
            >
              {state.sleepers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <section className="card chat" aria-live="polite">
        {turns.length === 0 && <p className="muted">{t('assistant.empty', { name: sleeper.name })}</p>}
        {turns.map((turn, i) => (
          <div key={i} className={`bubble ${turn.role}`}>
            {turn.text.split('\n\n').map((para, k) => (
              <p key={k}>{para}</p>
            ))}
          </div>
        ))}
        {waiting && <div className="bubble assistant muted">{t('assistant.thinking')}</div>}
        <div ref={end} />
      </section>
      <div className="row wrap">
        {chips.map((c) => (
          <button key={c} className="chip" disabled={waiting} onClick={() => ask(c)}>
            {c}
          </button>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <label className="grow">
          <span className="sr">{t('assistant.ask')}</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('assistant.placeholder')} />
        </label>
        <button className="primary" type="submit" disabled={waiting}>
          {t('assistant.send')}
        </button>
      </form>
    </div>
  );
}
