import type { Insight, NightDetailDto, NightSummaryDto } from '@tempcontrol/contracts';
import { describeInsight } from '@tempcontrol/engine';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, PlanChart, Scatter, SeriesChart } from '../charts';
import { useApp } from '../store';
import { eventText } from './Live';

export function History() {
  const { state, t, fmt, locale, units } = useApp();
  const [nights, setNights] = useState<NightSummaryDto[] | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [who, setWho] = useState<string | null>(null);
  const [detail, setDetail] = useState<NightDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const room = state?.rooms[0];
  const sleeper = state?.sleepers.find((s) => s.id === who) ?? state?.sleepers[0];
  const stamp = `${state?.household.id}:${state?.household.date}`;

  useEffect(() => {
    if (!room) return;
    let stale = false;
    setDetail(null);
    api
      .nights(room.id)
      .then((list) => !stale && setNights(list))
      .catch((err: Error) => !stale && setError(err.message));
    return () => {
      stale = true;
    };
  }, [room?.id, stamp]);

  useEffect(() => {
    if (!sleeper) return;
    let stale = false;
    api
      .insights(sleeper.id)
      .then((list) => !stale && setInsights(list))
      .catch(() => !stale && setInsights([]));
    return () => {
      stale = true;
    };
  }, [sleeper?.id, stamp]);

  if (!state || !sleeper) return null;
  if (error) return <p className="note warn">{error}</p>;
  if (!nights) return <Empty>{t('loading')}</Empty>;
  if (nights.length === 0) return <Empty>{t('history.empty')}</Empty>;

  const names = Object.fromEntries(state.sleepers.map((s) => [s.id, s.name]));
  const mine = nights.map((n) => n.sleepers.find((s) => s.sleeperId === sleeper.id));
  const labels = nights.map((n) => fmt.day(n.date));
  const saved = state.savings;
  const points = nights.flatMap((n, i) => {
    const s = mine[i];
    return s && s.experiencedCoreC !== null && s.quality !== null ? [{ x: s.experiencedCoreC, y: s.quality, label: labels[i]! }] : [];
  });
  const open = (id: string): void => {
    api
      .night(id)
      .then(setDetail)
      .catch((err: Error) => setError(err.message));
  };

  return (
    <div className="stack">
      <header className="strip">
        <div>
          <h1>{t('history.title')}</h1>
          <p className="muted">{t('history.subtitle', { nights: nights.length })}</p>
        </div>
        {state.sleepers.length > 1 && (
          <label>
            <span className="sr">{t('history.sleeper')}</span>
            <select value={sleeper.id} onChange={(e) => setWho(e.target.value)}>
              {state.sleepers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="grid-2">
        <section className="card">
          <h2>{t('history.learning', { name: sleeper.name })}</h2>
          <p className="muted small">{t('history.learningNote')}</p>
          <SeriesChart
            labels={labels}
            aria={t('history.learning', { name: sleeper.name })}
            format={(v) => fmt.temp(v)}
            reference={sleeper.demo ? { value: sleeper.demo.trueIdealC, label: t('history.truth') } : undefined}
            series={[
              {
                id: 'estimate',
                label: t('history.estimate'),
                color: 'c1',
                values: mine.map((s) => s?.estimateC ?? null),
                band: { lo: mine.map((s) => (s ? s.estimateC - s.sdC : sleeper.estimate.coreC)), hi: mine.map((s) => (s ? s.estimateC + s.sdC : sleeper.estimate.coreC)) },
              },
            ]}
          />
        </section>
        <section className="card">
          <h2>{t('history.scatter')}</h2>
          <p className="muted small">{t('history.scatterNote')}</p>
          {points.length < 3 ? (
            <Empty>{t('history.tooFew')}</Empty>
          ) : (
            <Scatter
              points={points}
              aria={t('history.scatter')}
              xTitle={t('history.experienced')}
              yTitle={t('history.score')}
              formatX={(v) => fmt.temp(v)}
              formatY={(v) => `${Math.round(v)}`}
              marker={{ x: sleeper.estimate.coreC, label: t('history.estimate') }}
            />
          )}
        </section>
      </div>

      <section className="card">
        <h2>{t('history.energy')}</h2>
        <div className="row wrap tiles">
          <div className="tile">
            <span className="tile-label">{saved.savedCents >= 0 ? t('savings.saved') : t('savings.extra')}</span>
            <span className="tile-value">{fmt.money(saved.savedCents)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">{saved.savedKWh >= 0 ? t('savings.kwhLess') : t('savings.kwhMore')}</span>
            <span className="tile-value">{fmt.num(Math.abs(saved.savedKWh))} kWh</span>
          </div>
          <div className="tile">
            <span className="tile-label">{t('savings.nights')}</span>
            <span className="tile-value">{saved.nights}</span>
          </div>
        </div>
        <p className="muted small">{t('history.energyNote')}</p>
        <SeriesChart
          labels={labels}
          aria={t('history.energy')}
          zero
          format={(v) => `${fmt.num(v)} kWh`}
          series={[
            { id: 'used', label: t('history.used'), color: 'c1', values: nights.map((n) => n.kWh) },
            { id: 'baseline', label: t('history.baseline'), color: 'muted', thin: true, values: nights.map((n) => n.baselineKWh) },
          ]}
        />
      </section>

      <section className="card">
        <h2>{t('history.insights', { name: sleeper.name })}</h2>
        <ul className="plain">
          {insights.map((i) => (
            <li key={i.id}>{describeInsight(i, { locale, units })}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>{t('history.nights')}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('history.col.date')}</th>
                <th scope="col" className="num">{t('history.col.target')}</th>
                <th scope="col" className="num">{t('history.col.room')}</th>
                {state.sleepers.map((s) => (
                  <th key={s.id} scope="col" className="num">
                    {s.name}
                  </th>
                ))}
                <th scope="col" className="num">{t('history.col.live')}</th>
                <th scope="col" className="num">{t('history.col.manual')}</th>
                <th scope="col" className="num">{t('history.col.energy')}</th>
                <th scope="col">
                  <span className="sr">{t('history.col.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...nights].reverse().slice(0, 30).map((n) => (
                <tr key={n.id} className={detail?.id === n.id ? 'selected' : ''}>
                  <th scope="row">{fmt.day(n.date)}</th>
                  <td className="num">{fmt.temp(n.coreTargetC)}</td>
                  <td className="num">{fmt.temp(n.avgRoomTempC)}</td>
                  {state.sleepers.map((s) => {
                    const q = n.sleepers.find((x) => x.sleeperId === s.id)?.quality;
                    return (
                      <td key={s.id} className="num">
                        {q === null || q === undefined ? '–' : Math.round(q)}
                      </td>
                    );
                  })}
                  <td className="num">{n.liveAdjustments}</td>
                  <td className="num">{n.manualChanges}</td>
                  <td className="num">
                    {fmt.num(n.kWh)} / {fmt.num(n.baselineKWh)}
                  </td>
                  <td>
                    <button className="link" onClick={() => open(n.id)}>
                      {t('history.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t('history.tableNote')}</p>
      </section>

      {detail && (
        <section className="card" aria-labelledby="night-title">
          <h2 id="night-title">{t('history.night', { date: fmt.day(detail.date) })}</h2>
          <PlanChart plan={detail.plan} ticks={detail.trace} names={names} />
          <h3>{t('live.events')}</h3>
          {detail.events.length === 0 ? (
            <p className="muted">{t('live.noEvents')}</p>
          ) : (
            <ol className="feed">
              {detail.events.map((e, i) => (
                <li key={`${e.t}-${i}`}>
                  <time>{fmt.clock(e.t)}</time> {eventText(e, names, t, fmt)}
                </li>
              ))}
            </ol>
          )}
          <h3>{t('history.outdoor')}</h3>
          <SeriesChart
            height={130}
            labels={detail.trace.map((k) => fmt.clock(k.t))}
            aria={t('history.outdoor')}
            format={(v) => fmt.temp(v)}
            series={[{ id: 'out', label: t('history.outdoor'), color: 'muted', values: detail.trace.map((k) => k.outdoorC) }]}
          />
        </section>
      )}
    </div>
  );
}
