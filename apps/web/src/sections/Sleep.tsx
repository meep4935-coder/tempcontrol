import type { Insight, NightDetailDto, NightSummaryDto } from '@tempcontrol/contracts';
import { describeInsight } from '@tempcontrol/engine';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Bars, Curve, Progress, Ring } from '../charts';
import { useApp } from '../store';
import { Icon, Sheet } from '../ui';
import { eventText } from './Live';

/** The few observations worth a non-technical reader's time. */
const WORTH_SAYING: Insight['id'][] = ['bestBand', 'trend', 'seasonShift', 'cannotReach', 'overrides', 'liveAdjustments'];

export function Sleep() {
  const { state, me, t, fmt, locale, units } = useApp();
  const [nights, setNights] = useState<NightSummaryDto[] | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NightDetailDto | null>(null);
  const room = state?.rooms[0];
  const stamp = `${state?.household.id}:${state?.household.date}`;

  useEffect(() => {
    if (!room || !me) return;
    let stale = false;
    api
      .nights(room.id, 60)
      .then((list) => !stale && setNights(list))
      .catch(() => !stale && setNights([]));
    api
      .insights(me.id)
      .then((list) => !stale && setInsights(list))
      .catch(() => !stale && setInsights([]));
    return () => {
      stale = true;
    };
  }, [room?.id, me?.id, stamp]);

  useEffect(() => {
    setDetail(null);
    if (!openId) return;
    let stale = false;
    api
      .night(openId)
      .then((n) => !stale && setDetail(n))
      .catch(() => !stale && setOpenId(null));
    return () => {
      stale = true;
    };
  }, [openId]);

  if (!state || !me) return null;
  if (!nights) return <p className="empty">{t('loading')}</p>;

  const own = [...nights]
    .filter((n) => n.kind === 'night')
    .sort((a, b) => a.startMs - b.startMs)
    .map((n) => ({ night: n, score: n.sleepers.find((s) => s.sleeperId === me.id)?.quality ?? null }));
  const week = own.slice(-7);
  const scores = week.map((w) => w.score).filter((v): v is number => v !== null);
  const average = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const weekday = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { weekday: 'narrow', timeZone: 'UTC' });
  const e = me.estimate;
  const saved = state.savings;
  const notes = insights.filter((i) => WORTH_SAYING.includes(i.id)).slice(0, 2);
  const names = Object.fromEntries(state.sleepers.map((s) => [s.id, s.name]));
  const mineIn = detail?.sleepers.find((s) => s.sleeperId === me.id);

  return (
    <div className="stack">
      <section className="card">
        <p className="eyebrow">{t('sleep.best')}</p>
        <p className="big-number">{fmt.deg(e.coreC)}</p>
        <Progress value={e.confidence} label={t('sleep.learning')} />
        <p className="muted">{t(e.confidence >= 0.8 ? 'sleep.learned' : 'sleep.stillLearning', { pct: Math.round(e.confidence * 100), nights: own.length })}</p>
      </section>

      {own.length === 0 ? (
        <section className="card">
          <p>{t('sleep.empty')}</p>
          <a className="button primary" href="#tonight">
            {t('tab.tonight')}
          </a>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="split">
              <div>
                <p className="eyebrow">{t('sleep.week')}</p>
                <p className="big-number">{average === null ? '–' : Math.round(average)}</p>
              </div>
              <p className="muted right">{t('sleep.weekNote')}</p>
            </div>
            <Bars
              aria={t('sleep.week')}
              items={week.map((w) => ({
                key: w.night.id,
                label: weekday.format(new Date(`${w.night.date}T12:00:00Z`)),
                value: w.score,
                onClick: () => setOpenId(w.night.id),
              }))}
            />
          </section>

          <div className="tiles">
            <div className="tile">
              <span className="tile-label">{saved.savedCents >= 0 ? t('tile.saved') : t('tile.extra')}</span>
              <span className="tile-number">{fmt.money(saved.savedCents)}</span>
              <span className="tile-note">{t('tile.nights', { nights: saved.nights })}</span>
            </div>
            <div className="tile">
              <span className="tile-label">{saved.savedKWh >= 0 ? t('sleep.energyLess') : t('sleep.energyMore')}</span>
              <span className="tile-number">
                {fmt.num(Math.abs(saved.savedKWh))}
                <small> kWh</small>
              </span>
              <span className="tile-note">{t('sleep.energyNote')}</span>
            </div>
          </div>

          {notes.length > 0 && (
            <section className="card">
              <h2>{t('sleep.noticed')}</h2>
              <ul className="ticks">
                {notes.map((i) => (
                  <li key={i.id}>{describeInsight(i, { locale, units })}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="group">
            <h2 className="group-title">{t('sleep.nights')}</h2>
            <div className="group-body">
              {own
                .slice(-14)
                .reverse()
                .map(({ night, score }) => (
                  <button key={night.id} className="row tap" onClick={() => setOpenId(night.id)}>
                    <span className="row-text">
                      <span className="row-label">{fmt.day(night.date)}</span>
                      <span className="row-hint">{t('sleep.roomAt', { temp: fmt.temp(night.avgRoomTempC) })}</span>
                    </span>
                    <span className="row-value">
                      <span className="score">{score === null ? '–' : Math.round(score)}</span>
                      <Icon name="chevron" size={16} />
                    </span>
                  </button>
                ))}
            </div>
          </section>
        </>
      )}

      {openId && (
        <Sheet title={detail ? fmt.day(detail.date) : t('loading')} closeLabel={t('close')} onClose={() => setOpenId(null)}>
          {detail && (
            <div className="stack">
              <div className="center">
                <Ring value={mineIn?.quality ?? null} size={112} label={t('score')} />
                <p className="muted">{t('score')}</p>
              </div>
              <div className="tiles">
                <div className="tile">
                  <span className="tile-label">{t('morning.room')}</span>
                  <span className="tile-number">{fmt.deg(detail.avgRoomTempC)}</span>
                </div>
                <div className="tile">
                  <span className="tile-label">{detail.baselineCostCents - detail.costCents >= 0 ? t('tile.saved') : t('tile.extra')}</span>
                  <span className="tile-number">{fmt.money(detail.baselineCostCents - detail.costCents)}</span>
                </div>
              </div>
              <div className="plain-curve">
                <Curve startMs={detail.plan.startMs} endMs={detail.plan.endMs} segments={detail.plan.segments} ticks={detail.trace} height={110} aria={t('hero.curve')} deg={fmt.deg} clock={fmt.clock} />
                <p className="axis">
                  <span>{fmt.clock(detail.plan.startMs)}</span>
                  <span>{t('sleep.curveNote')}</span>
                  <span>{fmt.clock(detail.plan.endMs)}</span>
                </p>
              </div>
              {mineIn?.feedback && <p className="muted">{t('sleep.youSaid', { answer: t(`feedback.${mineIn.feedback}`) })}</p>}
              {detail.events.length > 0 && (
                <ol className="feed">
                  {detail.events.slice(0, 5).map((ev, i) => (
                    <li key={`${ev.t}-${i}`}>
                      <time>{fmt.clock(ev.t)}</time>
                      <span>{eventText(ev, names, t, fmt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}
