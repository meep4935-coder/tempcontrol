/**
 * The platform's own assistant.
 *
 * It is purpose-built rather than a general chatbot: it recognises the
 * questions people ask about sleep temperature (in English and French), and
 * answers each one from that sleeper's own numbers. It uses no outside AI
 * service, so nothing about the sleeper leaves the platform, it costs nothing
 * per question, and it can only say things the data supports.
 *
 * How it works: the question is matched against phrase lists, one per topic;
 * the best-matching topic's answer is then written from the context below.
 * Adding a topic means adding a phrase list and an answer function.
 */

import type { Modifier } from './context';
import type { EnergyChange } from './energy';
import { describeInsight, formatDelta, formatTemp } from './insightText';
import type { Insight } from './insights';
import type { IdealEstimate } from './model';
import type { SeasonName } from './season';
import type { Locale, Phase, SleeperOptions, Units } from './types';
import { localParts } from './util';

export type AssistantTopic =
  | 'ideal'
  | 'tonight'
  | 'lastNight'
  | 'trend'
  | 'learning'
  | 'recommendation'
  | 'savings'
  | 'partner'
  | 'season'
  | 'control'
  | 'wearable'
  | 'tooHot'
  | 'tooCold'
  | 'health'
  | 'recovery'
  | 'travel'
  | 'privacy'
  | 'medical'
  | 'help'
  | 'unknown';

export interface AssistantContext {
  estimate: IdealEstimate;
  insights: Insight[];
  season: SeasonName;
  options: SleeperOptions;
  /** Whether the household has switched on setting the temperature by hand. */
  manualControl: boolean;
  wearable: { name: string; delivery: 'live' | 'morning' };
  /** Tonight's schedule for the room, or null if none can be made. */
  tonight: {
    timeZone: string;
    steps: { phase: Phase; startMs: number; endMs: number; targetC: number }[];
    modifiers: Modifier[];
    explorationC: number;
    /** Name of the preset the room is running on; null when automatic. */
    presetName: string | null;
    /** One-night manual temperature, if set. */
    holdC: number | null;
    energyChanges: EnergyChange[];
    /** Other people sharing the room. */
    partners: number;
    /** Difference between the partners' ideal temperatures. */
    gapC: number;
  } | null;
  lastNight: {
    experiencedCoreC: number | null;
    quality: number | null;
    liveAdjustments: number;
    manualChanges: number;
  } | null;
  savings: { nights: number; savedKWh: number; savedCents: number } | null;
}

export interface AssistantReply {
  topic: AssistantTopic;
  text: string;
  followUps: string[];
}

export interface AssistantOptions {
  locale: Locale;
  units: Units;
}

/* ------------------------------------------------------------ understanding */

/** Phrases per topic, both languages together, written without accents (the question is normalised the same way). */
const PHRASES: Record<Exclude<AssistantTopic, 'unknown'>, string[]> = {
  medical: [
    'insomnia', 'apnea', 'apnoea', 'medication', 'medicine', 'doctor', 'fever', 'pill', 'melatonin', 'diagnos', 'snor',
    'insomnie', 'apnee', 'medicament', 'medecin', 'fievre', 'pilule', 'melatonine', 'ronfl',
  ],
  tooHot: ['too hot', 'too warm', 'sweat', 'i am hot', 'im hot', 'overheat', 'trop chaud', 'j ai chaud', 'transpir', 'sueur', 'je sue'],
  tooCold: ['too cold', 'too cool', 'freezing', 'i am cold', 'im cold', 'shiver', 'trop froid', 'j ai froid', 'je gele', 'frette', 'grelott'],
  savings: [
    'sav', 'energy', 'bill', 'cost', 'money', 'electric', 'price', 'peak', 'kwh',
    'econom', 'energie', 'facture', 'cout', 'argent', 'electricit', 'prix', 'pointe', 'hydro',
  ],
  partner: ['partner', 'wife', 'husband', 'spouse', 'couple', 'share', 'both of us', 'conjoint', 'partenaire', 'mari', 'femme', 'epou', 'blonde', 'chum', 'a deux', 'partage'],
  recommendation: ['recommend', 'should i', 'suggest', 'advice', 'what do i do', 'recommand', 'conseil', 'sugger', 'devrais je', 'que faire'],
  lastNight: ['last night', 'how did i sleep', 'yesterday', 'my score', 'nuit derniere', 'nuit passee', 'hier', 'ai je bien dormi', 'mon score', 'comment j ai dormi'],
  tonight: ['tonight', 'plan', 'schedule', 'this evening', 'why is it', 'ce soir', 'cette nuit', 'horaire', 'programme', 'pourquoi fait il', 'pourquoi est ce'],
  ideal: ['ideal', 'best temperature', 'optimal', 'right temperature', 'what temperature', 'perfect', 'meilleure temperature', 'quelle temperature', 'bonne temperature', 'parfait'],
  trend: ['improv', 'getting better', 'trend', 'progress', 'worse', 'amelior', 'tendance', 'progres', 'mieux', 'pire'],
  learning: [
    'learn', 'calibrat', 'how long', 'personali', 'algorithm', 'accurate', 'confiden',
    'apprend', 'calibr', 'combien de temps', 'personnalis', 'algorithme', 'precis', 'fiable',
  ],
  season: ['winter', 'summer', 'season', 'spring', 'autumn', 'fall', 'morning', 'wake', 'hiver', 'ete', 'saison', 'printemps', 'automne', 'matin', 'reveil'],
  control: [
    'override', 'manual', 'preset', 'change the temperature', 'set the temperature', 'control', 'voice', 'siri', 'alexa', 'google',
    'manuel', 'prereglage', 'changer la temperature', 'regler', 'controle', 'vocal', 'voix',
  ],
  wearable: ['watch', 'ring', 'band', 'wearable', 'oura', 'whoop', 'garmin', 'fitbit', 'sync', 'live', 'montre', 'bague', 'bracelet', 'synchron', 'en direct'],
  health: ['cycle', 'period', 'menopause', 'hot flash', 'hot flush', 'luteal', 'regles', 'bouffee', 'menstru'],
  recovery: ['workout', 'training', 'exercise', 'gym', 'alcohol', 'drink', 'wine', 'beer', 'sick', 'ill', 'cold or flu', 'entrainement', 'exercice', 'sport', 'alcool', 'vin', 'biere', 'malade', 'grippe'],
  travel: ['travel', 'jet lag', 'jetlag', 'trip', 'time zone', 'flight', 'nap', 'voyage', 'decalage', 'fuseau', 'vol', 'sieste'],
  privacy: ['privacy', 'private', 'my data', 'who sees', 'who can see', 'confidential', 'share my', 'vie privee', 'mes donnees', 'qui voit', 'confidenti'],
  help: ['hello', 'hi ', 'hey', 'help', 'what can you', 'who are you', 'bonjour', 'salut', 'allo', 'aide', 'que peux tu', 'que pouvez vous', 'qui es tu', 'qui etes vous'],
};

/** "How does it work?" with nothing more specific is a question about the system itself. */
const GENERAL_HOW = ['how do you', 'how does it', 'how does this', 'how it works', 'comment ca marche', 'comment ca fonctionne', 'comment fonctionne'];

/** Lower-case, strip accents and punctuation, pad with spaces so phrases match on word starts. */
function normalise(text: string): string {
  const plain = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${plain} `;
}

/** The topic a question is about: the one whose phrases match most, longer phrases counting for more. */
export function classifyQuestion(question: string): AssistantTopic {
  const text = normalise(question);
  // Anything touching on a medical matter is answered as such, whatever else the question mentions.
  if (PHRASES.medical.some((phrase) => text.includes(` ${phrase}`))) return 'medical';
  let best: AssistantTopic = 'unknown';
  let bestScore = 0;
  for (const topic of Object.keys(PHRASES) as Exclude<AssistantTopic, 'unknown'>[]) {
    let score = 0;
    for (const phrase of PHRASES[topic]) {
      if (text.includes(` ${phrase}`)) score += 1 + phrase.trim().split(' ').length;
    }
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  if (best === 'unknown' && GENERAL_HOW.some((phrase) => text.includes(` ${phrase}`))) return 'learning';
  return best;
}

/* ---------------------------------------------------------------- answering */

const PHASE_NAMES: Record<Locale, Record<Phase, string>> = {
  en: { windDown: 'before bed', onset: 'falling asleep', deep: 'deep sleep', rem: 'late sleep', wake: 'waking up' },
  fr: { windDown: 'avant le coucher', onset: "l'endormissement", deep: 'le sommeil profond', rem: 'la fin de nuit', wake: 'le réveil' },
};

const FOLLOW_UPS: Record<Locale, Partial<Record<AssistantTopic, string>>> = {
  en: {
    ideal: 'What is my ideal temperature?',
    tonight: "What is tonight's plan?",
    lastNight: 'How did I sleep last night?',
    learning: 'How does it learn?',
    recommendation: 'What do you recommend?',
    savings: 'How much have I saved?',
    partner: 'How does it work for two people?',
    season: 'What changes in winter?',
    control: 'How do I set the temperature myself?',
    wearable: 'Does my wearable report live?',
  },
  fr: {
    ideal: 'Quelle est ma température idéale ?',
    tonight: 'Quel est le plan pour ce soir ?',
    lastNight: "Comment ai-je dormi la nuit dernière ?",
    learning: 'Comment le système apprend-il ?',
    recommendation: 'Que recommandez-vous ?',
    savings: "Combien ai-je économisé ?",
    partner: 'Comment ça fonctionne à deux ?',
    season: "Qu'est-ce qui change en hiver ?",
    control: 'Comment régler la température moi-même ?',
    wearable: 'Mon appareil transmet-il en direct ?',
  },
};

const RELATED: Record<AssistantTopic, AssistantTopic[]> = {
  ideal: ['tonight', 'learning', 'recommendation'],
  tonight: ['ideal', 'control', 'savings'],
  lastNight: ['recommendation', 'ideal', 'tonight'],
  trend: ['lastNight', 'ideal', 'recommendation'],
  learning: ['ideal', 'wearable', 'tonight'],
  recommendation: ['tonight', 'ideal', 'control'],
  savings: ['tonight', 'season', 'recommendation'],
  partner: ['tonight', 'ideal', 'control'],
  season: ['tonight', 'savings', 'ideal'],
  control: ['tonight', 'recommendation', 'ideal'],
  wearable: ['learning', 'tonight', 'ideal'],
  tooHot: ['control', 'ideal', 'tonight'],
  tooCold: ['control', 'ideal', 'tonight'],
  health: ['tonight', 'control', 'learning'],
  recovery: ['tonight', 'lastNight', 'learning'],
  travel: ['tonight', 'control', 'ideal'],
  privacy: ['learning', 'wearable', 'control'],
  medical: ['lastNight', 'ideal', 'tonight'],
  help: ['ideal', 'tonight', 'savings'],
  unknown: ['ideal', 'tonight', 'recommendation'],
};

export function answerQuestion(question: string, ctx: AssistantContext, opts: AssistantOptions): AssistantReply {
  const topic = classifyQuestion(question);
  const fr = opts.locale === 'fr';
  const temp = (c: number): string => formatTemp(c, opts);
  const delta = (c: number): string => formatDelta(c, opts);
  const { estimate: e, tonight, lastNight } = ctx;
  const percent = `${Math.round(e.confidence * 100)}${fr ? ' ' : ''}%`;
  const insight = (id: Insight['id']): string | null => {
    const found = ctx.insights.find((i) => i.id === id);
    return found ? describeInsight(found, opts) : null;
  };

  const clock = (ms: number): string => {
    const p = localParts(ms, tonight?.timeZone ?? 'UTC');
    const mm = String(p.minute).padStart(2, '0');
    return fr ? `${p.hour} h ${mm}` : `${String(p.hour).padStart(2, '0')}:${mm}`;
  };

  const idealLine = fr
    ? `Vos données situent votre température idéale de sommeil profond à ${temp(e.coreC)}, à ${delta(e.sdC)} près (${e.nights} nuit${e.nights === 1 ? '' : 's'} analysée${e.nights === 1 ? '' : 's'}, personnalisation à ${percent}).`
    : `Your data put your ideal deep-sleep temperature at ${temp(e.coreC)}, give or take ${delta(e.sdC)} (${e.nights} night${e.nights === 1 ? '' : 's'} analysed, ${percent} personalised).`;

  /** Tonight's schedule as one sentence: one entry per phase, at its final temperature. */
  const scheduleLine = (): string | null => {
    if (!tonight) return null;
    const parts: string[] = [];
    for (const phase of ['onset', 'deep', 'rem', 'wake'] as Phase[]) {
      const steps = tonight.steps.filter((s) => s.phase === phase);
      const last = steps[steps.length - 1];
      if (last) parts.push(fr ? `${temp(last.targetC)} pour ${PHASE_NAMES.fr[phase]} (dès ${clock(steps[0]!.startMs)})` : `${temp(last.targetC)} for ${PHASE_NAMES.en[phase]} (from ${clock(steps[0]!.startMs)})`);
    }
    return fr ? `Ce soir : ${parts.join(', ')}.` : `Tonight: ${parts.join(', ')}.`;
  };

  const reasons = (): string[] => {
    if (!tonight) return [];
    const out: string[] = [];
    const text: Record<Modifier['id'], [string, string]> = {
      cycle: ['of where you are in your cycle', 'de la phase de votre cycle'],
      menopause: ['menopause mode is on', 'le mode ménopause est activé'],
      strain: ['you trained hard today', "vous vous êtes beaucoup entraîné aujourd'hui"],
      alcohol: ['you had drinks tonight', 'vous avez bu de l’alcool ce soir'],
      illness: ['you seem unwell', 'vous semblez malade'],
    };
    for (const m of tonight.modifiers) {
      const [en, french] = text[m.id];
      const dir = m.deltaC < 0 ? (fr ? 'plus fraîche' : 'cooler') : fr ? 'plus chaude' : 'warmer';
      out.push(fr ? `La chambre est ${delta(m.deltaC)} ${dir} parce que ${french}.` : `The room is ${delta(m.deltaC)} ${dir} because ${en}.`);
    }
    if (tonight.explorationC !== 0) {
      const dir = tonight.explorationC < 0 ? (fr ? 'plus fraîche' : 'cooler') : fr ? 'plus chaude' : 'warmer';
      out.push(
        fr
          ? `Elle est aussi ${delta(tonight.explorationC)} ${dir} que votre estimation : pendant le calibrage, une légère variation d'une nuit à l'autre permet de repérer ce qui vous convient le mieux.`
          : `It is also ${delta(tonight.explorationC)} ${dir} than your estimate: while calibrating, a small variation from night to night shows what suits you best.`,
      );
    }
    if (tonight.energyChanges.length > 0) {
      out.push(
        fr
          ? "Le mode économie d'énergie a déplacé une partie du chauffage ou de la climatisation hors des heures les plus chères."
          : 'Energy mode has moved some of the heating or cooling out of the most expensive hours.',
      );
    }
    if (tonight.partners > 0) {
      out.push(
        fr
          ? `La chambre est partagée : la température suit un compromis à parts égales (vos températures idéales diffèrent de ${delta(tonight.gapC)}).`
          : `The room is shared, so the temperature follows an equal compromise (your ideal temperatures differ by ${delta(tonight.gapC)}).`,
      );
    }
    return out;
  };

  const modeLine = (): string | null => {
    if (!tonight) return null;
    if (tonight.holdC !== null) {
      return fr
        ? `Une température manuelle de ${temp(tonight.holdC)} est réglée pour cette nuit; elle a priorité sur tout le reste.`
        : `A manual temperature of ${temp(tonight.holdC)} is set for tonight; it takes priority over everything else.`;
    }
    if (tonight.presetName) {
      return fr
        ? `La chambre suit actuellement votre préréglage « ${tonight.presetName} » plutôt que le réglage recommandé.`
        : `The room is currently following your preset "${tonight.presetName}" rather than the recommended setting.`;
    }
    return null;
  };

  const paragraphs: (string | null)[] = [];
  switch (topic) {
    case 'ideal':
      paragraphs.push(idealLine, insight('bestBand'), insight('seasonShift'));
      break;
    case 'tonight':
      paragraphs.push(modeLine(), scheduleLine(), ...reasons());
      if (!tonight) paragraphs.push(fr ? "Aucun plan ne peut être établi : la chambre n'a pas de thermostat connecté." : 'No plan can be made: the room has no connected thermostat.');
      break;
    case 'lastNight':
      if (!lastNight) {
        paragraphs.push(fr ? "Il n'y a pas encore de nuit enregistrée." : 'There is no recorded night yet.');
      } else {
        const score = lastNight.quality === null ? null : Math.round(lastNight.quality);
        paragraphs.push(
          score === null
            ? fr
              ? "Votre appareil n'a pas encore transmis les données de la nuit dernière."
              : 'Your wearable has not sent last night’s data yet.'
            : fr
              ? `La nuit dernière, votre score de sommeil était de ${score} sur 100.`
              : `Last night your sleep score was ${score} out of 100.`,
        );
        if (lastNight.experiencedCoreC !== null) {
          const off = lastNight.experiencedCoreC - e.coreC;
          const near = Math.abs(off) < 0.5;
          paragraphs.push(
            fr
              ? `La chambre correspondait à ${temp(lastNight.experiencedCoreC)} en sommeil profond, ${near ? 'tout près de' : off > 0 ? `${delta(off)} au-dessus de` : `${delta(off)} sous`} votre idéal estimé.`
              : `The room was the equivalent of ${temp(lastNight.experiencedCoreC)} in deep sleep, ${near ? 'right at' : off > 0 ? `${delta(off)} above` : `${delta(off)} below`} your estimated ideal.`,
          );
        }
        if (lastNight.liveAdjustments > 0) {
          paragraphs.push(
            fr
              ? `La température a été ajustée ${lastNight.liveAdjustments} fois pendant la nuit d'après les signaux de votre montre.`
              : `The temperature was adjusted ${lastNight.liveAdjustments} time${lastNight.liveAdjustments === 1 ? '' : 's'} during the night from what your watch reported.`,
          );
        }
        if (lastNight.manualChanges > 0) {
          paragraphs.push(fr ? 'Vous avez aussi réglé la température à la main; le système en tient compte.' : 'You also set the temperature by hand; the system takes that into account.');
        }
      }
      break;
    case 'trend':
      paragraphs.push(insight('trend') ?? (fr ? "Il n'y a pas encore assez de nuits pour dégager une tendance (il en faut quatorze)." : 'There are not enough nights yet to see a trend (it takes fourteen).'), insight('bestBand'));
      break;
    case 'learning':
      paragraphs.push(
        fr
          ? "Le système apprend de deux choses : la qualité de votre sommeil aux températures que vous avez réellement connues, mesurée par votre appareil, et ce que vous lui dites (un réglage manuel, « trop chaud », « trop froid », « parfait »)."
          : 'The system learns from two things: how well you slept at the temperatures you actually experienced, as measured by your wearable, and what you tell it (a manual change, "too warm", "too cold", "just right").',
        fr
          ? "Dès la première nuit, il part d'une courbe type pour un adulte. Pendant le calibrage, il varie la température d'un demi-degré d'une nuit à l'autre; cela s'arrête de soi-même une fois votre préférence bien cernée, en général après deux à quatre semaines."
          : 'From the first night it starts from a typical adult curve. While calibrating it varies the temperature by half a degree from night to night; that stops by itself once your preference is pinned down, usually after two to four weeks.',
        idealLine,
      );
      break;
    case 'recommendation':
      paragraphs.push(
        idealLine,
        tonight?.presetName
          ? fr
            ? `Vous utilisez le préréglage « ${tonight.presetName} ». Nous recommandons plutôt le réglage automatique, qui suit vos données nuit après nuit; vous pouvez l'appliquer depuis la recommandation du matin.`
            : `You are on the preset "${tonight.presetName}". We recommend the automatic setting instead, which follows your data night after night; you can apply it from the morning recommendation.`
          : fr
            ? 'La chambre est déjà sur le réglage recommandé.'
            : 'The room is already on the recommended setting.',
        scheduleLine(),
        insight('cannotReach'),
      );
      break;
    case 'savings':
      paragraphs.push(
        insight('energy') ??
          (fr ? "Il n'y a pas encore assez de nuits pour chiffrer les économies." : 'There are not enough nights yet to put a figure on savings.'),
        fr
          ? "Les économies sont calculées par rapport au thermostat laissé à son réglage de jour toute la nuit. En mode économie d'énergie, le chauffage et la climatisation sont aussi déplacés hors des heures les plus chères, dans la limite de confort que vous fixez."
          : 'Savings are measured against leaving the thermostat at its daytime setting all night. In energy mode, heating and cooling are also moved out of the most expensive hours, within the comfort tolerance you set.',
      );
      break;
    case 'partner':
      paragraphs.push(
        fr
          ? "Chaque personne a son propre profil, appris à partir de son propre appareil. Comme il n'y a qu'un climatiseur pour la chambre, la température suit un compromis : chaque personne au lit compte à parts égales, et celle qui n'est pas encore couchée, ou déjà levée, compte pour moitié."
          : 'Each person has their own profile, learned from their own wearable. Because the room has one air conditioner, the temperature follows a compromise: each person in bed counts equally, and someone not yet in bed, or already up, counts for half.',
        tonight && tonight.partners > 0
          ? fr
            ? `Vos températures idéales diffèrent actuellement de ${delta(tonight.gapC)}.`
            : `Your ideal temperatures currently differ by ${delta(tonight.gapC)}.`
          : fr
            ? "Vous êtes pour l'instant la seule personne dans cette chambre."
            : 'You are currently the only person in this room.',
      );
      break;
    case 'season':
      paragraphs.push(
        fr
          ? "En hiver, la chambre est davantage réchauffée avant le réveil, pour que sortir du lit soit plus facile; en été, ce réchauffement est plus léger. Le système apprend aussi si votre température idéale de nuit change avec la saison."
          : 'In winter the room is warmed more before you wake, so getting out of bed is easier; in summer that warm-up is lighter. The system also learns whether your ideal night temperature changes with the season.',
        insight('seasonShift'),
        scheduleLine(),
      );
      break;
    case 'control':
      paragraphs.push(
        !ctx.manualControl
          ? fr
            ? "Par défaut, la plateforme fonctionne toute seule : vous n'avez rien à régler. Si vous voulez fixer la température vous-même (à la main, par préréglage ou à la voix), activez le contrôle manuel dans les paramètres. Vous pouvez toujours dire « j'ai chaud » ou « j'ai froid » : cela améliore votre horaire automatique."
            : 'By default the platform runs on its own: there is nothing for you to set. If you want to set the temperature yourself (by hand, with a preset or by voice), switch on manual control in the settings. You can always say "I\'m hot" or "I\'m cold": that improves your automatic schedule.'
          : fr
            ? "Le contrôle manuel est activé. Une température réglée à la main, dans l'application ou à la voix (« mets la chambre à 19 »), a priorité pour la nuit. Un préréglage remplace le réglage automatique nuit après nuit, jusqu'à ce que vous reveniez à l'automatique."
            : 'Manual control is on. A temperature set by hand, in the app or by voice ("set the bedroom to 19"), takes priority for the night. A preset replaces the automatic setting night after night until you go back to automatic.',
        modeLine(),
      );
      break;
    case 'wearable':
      paragraphs.push(
        ctx.wearable.delivery === 'live'
          ? fr
            ? `Votre ${ctx.wearable.name} peut transmettre pendant la nuit. Si elle signale que vous êtes agité et que vous avez chaud ou froid, la chambre est ajustée d'un demi-degré sur-le-champ.`
            : `Your ${ctx.wearable.name} can report during the night. If it shows you restless and warm or cold, the room is adjusted by half a degree there and then.`
          : fr
            ? `Votre ${ctx.wearable.name} envoie ses données une fois la nuit terminée, lorsqu'il se synchronise au réveil. Le système ne peut donc pas réagir pendant la nuit : il apprend d'une nuit à l'autre et améliore le plan du lendemain.`
            : `Your ${ctx.wearable.name} sends its data once the night is over, when it syncs after you wake. So the system cannot react during the night: it learns from one night to the next and improves the following night's plan.`,
      );
      break;
    case 'tooHot':
    case 'tooCold': {
      const hot = topic === 'tooHot';
      paragraphs.push(
        fr
          ? `Dites-le au système : « ${hot ? "j'ai chaud" : "j'ai froid"} » à la voix, ou ${hot ? 'baissez' : 'montez'} la température dans l'application. La chambre change tout de suite, et votre préférence est retenue pour les nuits suivantes.`
          : `Tell the system: say "${hot ? "I'm hot" : "I'm cold"}", or turn the temperature ${hot ? 'down' : 'up'} in the app. The room changes straight away, and your preference is remembered for the following nights.`,
        idealLine,
        insight('cannotReach'),
      );
      break;
    }
    case 'health':
      paragraphs.push(
        fr
          ? "Deux réglages facultatifs existent. Le suivi du cycle rafraîchit légèrement la chambre après l'ovulation, quand la température du corps est plus élevée. Le mode ménopause garde la chambre un peu plus fraîche et, avec une montre qui transmet en direct, déclenche un bref rafraîchissement lors d'une bouffée de chaleur."
          : 'Two optional settings exist. Cycle tracking cools the room slightly after ovulation, when body temperature runs higher. Menopause mode keeps the room a little cooler and, with a watch that reports live, triggers a short burst of cooling during a hot flash.',
        fr
          ? `Suivi du cycle : ${ctx.options.cycleTracking ? 'activé' : 'désactivé'}. Mode ménopause : ${ctx.options.menopauseMode ? 'activé' : 'désactivé'}.`
          : `Cycle tracking: ${ctx.options.cycleTracking ? 'on' : 'off'}. Menopause mode: ${ctx.options.menopauseMode ? 'on' : 'off'}.`,
      );
      break;
    case 'recovery':
      paragraphs.push(
        fr
          ? "Après un entraînement intense, la première moitié de la nuit est un peu plus fraîche; après de l'alcool, toute la nuit l'est; si vous êtes malade, la chambre est légèrement réchauffée. Les nuits marquées par l'alcool ou la maladie ne servent pas à l'apprentissage, car la température n'y est pas la cause principale d'un mauvais sommeil."
          : 'After hard training the first half of the night runs a little cooler; after alcohol the whole night does; if you are unwell the room is warmed slightly. Nights marked by alcohol or illness are not used for learning, because temperature is not the main reason for poor sleep on them.',
        ...reasons().slice(0, 2),
      );
      break;
    case 'travel':
      paragraphs.push(
        fr
          ? "Votre profil vous suit : il est lié à vous, pas à la chambre. Avant un voyage, le planificateur de décalage horaire déplace peu à peu vos heures de coucher et de lever, et le plan de la nuit suit. Pour une sieste, la chambre est réglée à la température d'endormissement puis réchauffée juste avant le réveil."
          : 'Your profile travels with you: it belongs to you, not the room. Before a trip the jet-lag planner shifts your bedtime and wake time gradually, and the night plan follows. For a nap the room is set to your falling-asleep temperature and warmed just before you wake.',
      );
      break;
    case 'privacy':
      paragraphs.push(
        fr
          ? "Cet assistant fonctionne entièrement sur la plateforme : vos questions et vos données ne sont envoyées à aucun service d'intelligence artificielle externe. Un partenaire qui partage votre chambre voit le plan commun, pas vos données de sommeil."
          : 'This assistant runs entirely on the platform: your questions and your data are not sent to any outside AI service. A partner who shares your room sees the shared plan, not your sleep data.',
      );
      break;
    case 'medical':
      paragraphs.push(
        fr
          ? "Je ne peux pas donner d'avis médical. Si vos nuits vous inquiètent (insomnie persistante, pauses respiratoires, fièvre, sueurs nocturnes importantes), parlez-en à un médecin. Je peux en revanche vous aider pour la température."
          : 'I cannot give medical advice. If your nights worry you (persistent insomnia, pauses in breathing, fever, heavy night sweats), please raise it with a doctor. What I can help with is the temperature side.',
        idealLine,
      );
      break;
    case 'help':
    case 'unknown':
      paragraphs.push(
        topic === 'unknown'
          ? fr
            ? "Je n'ai pas compris la question. Je réponds aux questions sur la température de votre sommeil et sur vos données."
            : 'I did not understand that. I answer questions about your sleep temperature and your data.'
          : fr
            ? "Bonjour. Je suis l'assistant intégré : je réponds aux questions sur la température de votre sommeil à partir de vos propres données."
            : 'Hello. I am the built-in assistant: I answer questions about your sleep temperature from your own data.',
        fr
          ? "Vous pouvez me demander votre température idéale, le plan de ce soir et ses raisons, comment s'est passée la nuit dernière, ce que nous recommandons, vos économies d'énergie, ou comment fonctionne le système."
          : 'You can ask about your ideal temperature, tonight’s plan and the reasons for it, how last night went, what we recommend, your energy savings, or how the system works.',
      );
      break;
  }

  return {
    topic,
    text: paragraphs.filter((p): p is string => Boolean(p)).join('\n\n'),
    followUps: RELATED[topic].map((t) => FOLLOW_UPS[opts.locale][t]).filter((q): q is string => Boolean(q)),
  };
}
