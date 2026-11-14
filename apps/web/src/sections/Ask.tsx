import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { Icon } from '../ui';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  followUps?: string[];
}

const STARTERS: Record<'en' | 'fr', string[]> = {
  en: ["I'm too warm", 'What is my ideal temperature?', "What's the plan tonight?", 'How much have I saved?'],
  fr: ["J'ai trop chaud", 'Quelle est ma température idéale ?', 'Quel est le plan pour ce soir ?', "Combien ai-je économisé ?"],
};

/** A reply shows its first paragraph; the rest waits behind "More". */
function Bubble({ turn, more }: { turn: Turn; more: string }) {
  const [open, setOpen] = useState(false);
  const paras = turn.text.split('\n\n');
  return (
    <div className={`bubble ${turn.role}`}>
      {(open ? paras : paras.slice(0, 1)).map((para, k) => (
        <p key={k}>{para}</p>
      ))}
      {!open && paras.length > 1 && (
        <button className="link" onClick={() => setOpen(true)}>
          {more}
        </button>
      )}
    </div>
  );
}

const QUESTION = /\?\s*$|^(what|why|how|when|who|is|are|do|does|can|should|que|quel|quelle|pourquoi|comment|combien|quand|est-ce)\b/i;

interface Recognition {
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
}

/**
 * One box for everything said to the app. Requests ("I'm cold", "set 19")
 * go to the voice handler, the same one Siri or Alexa would reach; questions
 * go to the built-in assistant. Whichever does not understand hands over to
 * the other.
 */
export function Ask() {
  const { me, t, refresh } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [listening, setListening] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, waiting]);
  if (!me) return null;

  const speech = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Listener = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;

  const reply = async (q: string): Promise<Turn> => {
    const asAssistant = async (): Promise<Turn | null> => {
      const a = await api.ask(me.id, q);
      return a.topic === 'unknown' ? null : { role: 'assistant', text: a.text, followUps: a.followUps };
    };
    const asRequest = async (): Promise<Turn | null> => {
      const v = await api.voice(q, me.id);
      if (v.intent.type === 'unknown') return null;
      await refresh();
      return { role: 'assistant', text: v.reply };
    };
    const order = QUESTION.test(q) ? [asAssistant, asRequest] : [asRequest, asAssistant];
    return (await order[0]!()) ?? (await order[1]!()) ?? { role: 'assistant', text: t('ask.unknown') };
  };

  const ask = (question: string): void => {
    const q = question.trim();
    if (!q || waiting) return;
    setTurns((list) => [...list, { role: 'user', text: q }]);
    setText('');
    setWaiting(true);
    reply(q)
      .then((turn) => setTurns((list) => [...list, turn]))
      .catch((err: Error) => setTurns((list) => [...list, { role: 'assistant', text: err.message }]))
      .finally(() => setWaiting(false));
  };
  const listen = (): void => {
    if (!Listener) return;
    const rec = new Listener();
    rec.lang = me.locale === 'fr' ? 'fr-CA' : 'en-CA';
    rec.onresult = (e) => ask(e.results[0]?.[0]?.transcript ?? '');
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const last = turns[turns.length - 1];
  const chips = last?.role === 'assistant' && last.followUps?.length ? last.followUps.slice(0, 3) : STARTERS[me.locale];

  return (
    <div className="chat">
      <div className="chat-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-empty">
            <Icon name="spark" size={28} />
            <p>{t('ask.empty')}</p>
          </div>
        )}
        {turns.map((turn, i) => (
          <Bubble key={i} turn={turn} more={t('ask.more')} />
        ))}
        {waiting && <div className="bubble assistant muted">…</div>}
        <div ref={end} />
      </div>
      <div className="chat-dock">
        <div className="chips scroll">
          {chips.map((c) => (
            <button key={c} className="chip" disabled={waiting} onClick={() => ask(c)}>
              {c}
            </button>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ask.placeholder')} aria-label={t('ask.placeholder')} />
          {Listener && (
            <button type="button" className="round" aria-pressed={listening} onClick={listen} aria-label={t('ask.mic')}>
              <Icon name="mic" size={18} />
            </button>
          )}
          <button className="round primary" type="submit" disabled={waiting || text.trim() === ''} aria-label={t('ask.send')}>
            <Icon name="send" size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}
