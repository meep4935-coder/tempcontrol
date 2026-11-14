# TempControl

A sleep-temperature platform. It reads each sleeper's wearable, learns the bedroom temperature that person sleeps best at, and drives the smart thermostat through the night: cool for deep sleep, warmer before waking, blended fairly for couples, and always overridable by hand or by voice.

"TempControl" is a working name.

It assumes a sleeper has two things and nothing more: a wearable, and one smart-controlled air conditioner or thermostat in the bedroom.

This repository holds the working engine, the server and a phone-style web app, which run the whole thing against **simulated** wearables and thermostats, so the product can be seen working before any device developer accounts are opened.

## Run it

Needs Node 22.5 or newer.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:4000. The first start creates a demo household (a couple in Montréal) with ten nights of history.

The app is laid out like a phone app: four tabs (Tonight, Sleep, Ask, Settings), one big number per card, details behind a tap. It shows one person's view at a time, in that person's language and units; the round button at the top right switches person. The "Demo" button opens the tools that drive the simulation.

For development, `npm run dev` runs the server and the app with live reload (app on http://localhost:5173).

```bash
npm test
```

```bash
npm run typecheck
```

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `4000`, `127.0.0.1` | Where the server listens |
| `TEMPCONTROL_DB` | `data/tempcontrol.db` | SQLite file |
| `TEMPCONTROL_SCENARIO` | `couple` | Demo created on first start: `couple`, `solo` or `night-sweats` |
| `TEMPCONTROL_HISTORY_NIGHTS` | `10` | Nights simulated when the demo is created |

## What is real and what is simulated

| Part | Status |
|---|---|
| Learning model, night plans, couples blending, live adjustments, morning recommendation, energy shaping and savings, travel, voice parsing, built-in assistant | Real, tested code |
| Server, storage, API, control loop | Real |
| Wearables and thermostats | **Simulated.** Choosing "Nest" or "Oura" creates a simulated device |
| The sleepers | **Simulated people** with a hidden true preference the engine has to discover |
| Weather | Simulated from rounded climate normals |
| Electricity rates | Real published rates, but entered from search excerpts on 2026-11-13 because the utility sites could not be opened from the build environment. **Re-verify every figure before relying on it** (`packages/engine/src/tariffs.ts`) |
| Energy savings shown | Computed inside the simulation, against "thermostat left at its daytime setting" |
| The app's screens | Real: English and French, light and dark, phone-first. It is a web app, not yet an installable iOS, Android or watch app |

Nothing here has been tested on real people. Sleep and comfort figures in the demo come from the simulation and are not evidence of real-world results.

## Layout

```
packages/engine      The algorithm. Pure TypeScript, no dependencies, runs anywhere
packages/contracts   Types of every API request and response
apps/server          API, storage, control loop, simulated devices
apps/web             The app (phone-style web app)
```

A phone app (iOS and Android) would be a fifth package using the same engine types and the same API.

## How it works

**One model per sleeper.** The model's job is to estimate the room temperature a person sleeps best at during deep sleep, and how sure it is. It combines two kinds of evidence:

- *Sleep outcomes*: how well they slept at the temperatures they actually experienced, scored from the wearable's nightly data.
- *Stated preferences*: manual temperature changes and "too warm / too cold / just right".

Before any data it starts from a typical-adult curve, so the first night already has a sensible plan. While the estimate is uncertain, nights alternate half a degree above and below it; that stops by itself once the estimate is tight. Old evidence fades, and evidence that contradicts the current belief makes it fade faster, so the model follows someone whose preference changes.

**One plan per night.** Wind-down before bed, slightly warm while falling asleep, coolest in deep sleep, slightly warmer in late sleep, warmed before waking (more in winter). Where the sleeper has opted in, tonight's plan is adjusted for cycle phase, hard training, alcohol and illness. Every adjustment is named so the app can explain it.

**One schedule per room.** Each sleeper's plan is blended into the schedule the thermostat follows. Everyone in bed has an equal say; someone still winding down, or already up, counts for half. Energy mode then shifts heating and cooling out of expensive hours, inside a comfort tolerance the user sets.

**A control loop through the night.** Every few minutes: a manual temperature wins if one is set; otherwise the plan, nudged by live readings when the wearable reports during the night (restless and warm: cool half a degree; a hot flash, for those who switch that mode on: a short burst of cooling). In the morning the night becomes evidence for each sleeper's model.

**A recommendation each morning** (for rooms running a preset, when manual control is on). "Your data suggest X, so we recommend Y." The recommended setting is the automatic schedule. A room running on one of the user's presets is offered the choice every morning: apply the recommended setting, or keep the preset. The model keeps learning either way.

**Savings.** Every night's energy use and cost is compared with leaving the thermostat at its daytime setting, and the running total is reported.

**Manual control is an option, off by default.** The platform runs automatically; setting the temperature by hand, with a preset or by voice only works once the household switches it on. Saying "I'm hot" or "I'm cold" always counts as feedback.

**A built-in assistant.** It recognises the questions people ask about sleep temperature, in English and French, and answers each from that sleeper's own numbers. It is the platform's own code (`packages/engine/src/assistant.ts`): no outside AI service, nothing leaves the platform, and it declines medical questions.

`packages/engine/src/model.ts` has the full explanation of the learning model.

## Connecting real devices

The control loop talks to a `NightEnvironment` (`apps/server/src/environment.ts`). Today that is a simulation. Production needs an implementation of the same interface on top of:

- **Thermostats**: a device aggregator, the makers' own APIs, or Matter. Room-level control (baseboard thermostats, mini-split and window-unit controllers) matters as much as whole-home thermostats, because cooling one bedroom is cheaper and kinder to the rest of the household.
- **Wearables**: Apple Health on iPhone and Health Connect on Android for watches; the makers' cloud APIs for rings and bands, or an aggregator that covers several at once.
- **Voice**: the server already accepts a spoken or typed sentence at `POST /api/voice` in English and French. Siri (Shortcuts / App Intents), Alexa and Google Home would call it, or reach the platform by having it appear to them as a thermostat.

Things to confirm with each vendor before committing to a design, none of which this code assumes:

- Which wearables can deliver readings *during* the night. The demo marks watches as "live" on the assumption of a companion watch app; rings and bands sync in the morning. Skin temperature in particular is usually only available after the night.
- Rate limits and terms for commanding a thermostat several times a night.
- Developer-programme availability, fees and review times for each brand.

## Before real users

The demo is built to show the product working, not to be put on the internet as it is. Still to do before anyone's real bedroom depends on it:

- **Accounts and sign-in.** The server has no login: anyone who can reach it can change every setting. Partners linking their wearables need their own accounts and a consent step.
- **Real device connections**, as above, including what happens when a thermostat is offline or a command fails.
- **A real clock.** The demo advances a simulated calendar; production runs the same control loop on a timer against the real time.
- **A production database.** Records are JSON documents in SQLite, behind one class (`apps/server/src/store.ts`).
- **Current electricity rates**, from the utilities or a rates service, with peak events fetched automatically.
- **Evidence.** A pilot with real sleepers, measuring whether nights actually improve.

## Health and privacy

TempControl is not a medical device and gives no medical advice. Its adjustments for cycle phase, menopause, recovery and illness are starting assumptions that each person's data then revises; they are opt-in.

Wearable data is health information. In Canada that means PIPEDA, Québec's Law 25, and provincial health-privacy rules may apply; get legal advice before handling real users' data. No sleeper data is sent to any outside AI service.
