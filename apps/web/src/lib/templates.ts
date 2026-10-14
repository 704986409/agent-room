// Room templates seed a new meeting with a topic shape, suggested roles, and
// an opening message that demonstrates the [DECISION] / [TODO] / [STATUS] /
// [RESULT] markers so participants drop into a structured conversation
// instead of starting from a blank room.
//
// The opening message is sent as a normal `msg` from the creator on first
// load of the room — see Lobby for the wiring. Templates do NOT change the
// underlying Room schema; they're pure UI seed data.

import type { RolePreset } from '@agent-room/shared';
import { ROLE_PRESETS } from '@agent-room/shared';
import { translate, type Locale, type MessageKey } from '../i18n/messages.js';

export interface RoomTemplate {
  id: string;
  label: string;
  emoji: string;
  description: string;
  // Placeholder topic the host can edit. `{X}` markers signal "edit me here"
  // — we don't auto-replace, just hint visually.
  topicSeed: string;
  // RolePreset ids that this template recommends. Surfaced as chips so the
  // host can copy invite links pre-stamped with the role they want a teammate
  // / agent to play.
  suggestedRoleIds: string[];
  // First message in the room — frames the conversation and demos the tag
  // syntax so future participants follow the convention.
  openingMessage: string;
}

const r = (id: string): RolePreset | undefined => ROLE_PRESETS.find(p => p.id === id);

export const ROOM_TEMPLATES: RoomTemplate[] = [
  {
    id: 'blank',
    label: 'Blank room',
    emoji: '◇',
    description: 'Start with just a topic — no opening message, no role suggestions.',
    topicSeed: '',
    suggestedRoleIds: [],
    openingMessage: '',
  },
  {
    id: 'code-review',
    label: 'Code Review',
    emoji: '🔍',
    description: 'Walk a PR / patch through Builder, QA, and Skeptic agents and capture the verdict.',
    topicSeed: 'Code review: {pr-title-or-link}',
    suggestedRoleIds: ['builder', 'qa-reviewer', 'skeptic'],
    openingMessage:
      "Welcome — this is a code-review room. Use these markers as we go so the delivery report writes itself:\n\n" +
      "- `[DECISION]` for merge / block / refactor calls\n" +
      "- `[TODO]` for follow-up work the author needs to do\n" +
      "- `[STATUS]` for the current review state\n" +
      "- `[RESULT]` for the final outcome\n\n" +
      "Paste the diff or PR link to start.",
  },
  {
    id: 'feature-build',
    label: 'Feature Build',
    emoji: '🛠️',
    description: 'Greenfield development room — design, implement, and verify a new feature with Builder + QA + Facilitator.',
    topicSeed: 'Build: {feature-name}',
    suggestedRoleIds: ['facilitator', 'builder', 'qa-reviewer'],
    openingMessage:
      "Feature build room. Walk the work through: user story → design → tasks → implementation → tests. Mark output with:\n\n" +
      "- `[DECISION]` for scope / API shape / library choices\n" +
      "- `[TODO]` for each implementation task with an owner\n" +
      "- `[STATUS]` for progress (\"WIP\", \"PR up\", \"deployed to staging\")\n" +
      "- `[RESULT]` for shipped artifacts (PR link, deployed URL, test results)\n\n" +
      "Kickoff: what's the user story, what's the smallest shippable slice, who owns it?",
  },
  {
    id: 'bug-fix',
    label: 'Bug Fix',
    emoji: '🐛',
    description: 'Reproduce → root-cause → fix → verify. Builder + QA + Skeptic make sure the fix actually holds.',
    topicSeed: 'Bug: {short-description}',
    suggestedRoleIds: ['builder', 'qa-reviewer', 'skeptic'],
    openingMessage:
      "Bug-fix room. Step through: reproduce → narrow down → root cause → fix → verify. Mark each phase:\n\n" +
      "- `[STATUS]` reproducible / not-reproducible / intermittent + repro steps\n" +
      "- `[DECISION]` chosen fix approach (and what we explicitly rejected)\n" +
      "- `[TODO]` the fix work, the regression test to add, the cleanup\n" +
      "- `[RESULT]` verified resolution + commit/PR link, plus blast-radius note\n\n" +
      "Open with: minimal repro, observed vs expected behavior, environment, when it started.",
  },
  {
    id: 'incident',
    label: 'Incident Response',
    emoji: '🚨',
    description: 'Triage a production issue with structured timeline, decisions, and follow-ups.',
    topicSeed: 'Incident: {short-summary}',
    suggestedRoleIds: ['facilitator', 'builder', 'qa-reviewer'],
    openingMessage:
      "Incident room open. Keep updates short and use:\n\n" +
      "- `[STATUS]` whenever the situation changes (mitigated, rolled back, monitoring, etc.)\n" +
      "- `[DECISION]` for go/no-go calls (rollback, hotfix, declare resolved)\n" +
      "- `[TODO]` for postmortem follow-ups\n" +
      "- `[RESULT]` for the final resolution + customer impact\n\n" +
      "First message: what's broken, when it started, and current blast radius.",
  },
  {
    id: 'strategy',
    label: 'Strategy / Brainstorm',
    emoji: '🧭',
    description: 'Explore options with Researcher + Skeptic, converge on a direction with explicit decisions.',
    topicSeed: '{topic} — direction & next steps',
    suggestedRoleIds: ['facilitator', 'researcher', 'skeptic'],
    openingMessage:
      "Strategy room — diverge first, then converge. Mark output as you go:\n\n" +
      "- `[DECISION]` once the group commits to a path\n" +
      "- `[TODO]` for the work each path requires\n" +
      "- `[STATUS]` for assumption checks (\"validated\", \"open question\", \"blocked on X\")\n" +
      "- `[RESULT]` for the chosen direction + rationale\n\n" +
      "Open question: what are we optimizing for and what would change our mind?",
  },
  {
    id: 'delivery',
    label: 'Delivery Planning',
    emoji: '📦',
    description: 'Plan a deliverable with Builder + Writer and produce a client-ready report.',
    topicSeed: '{deliverable} — plan & ownership',
    suggestedRoleIds: ['facilitator', 'builder', 'writer'],
    openingMessage:
      "Delivery planning room. The end state is a client-ready report — every action you take should land in:\n\n" +
      "- `[DECISION]` scope, deadline, owner calls\n" +
      "- `[TODO]` work items with an owner attached\n" +
      "- `[STATUS]` daily progress updates\n" +
      "- `[RESULT]` shipped artifacts (links, docs, PRs)\n\n" +
      "Kickoff: what does \"done\" look like for the client, and who owns each piece?",
  },
];

export function templateById(id: string | null | undefined): RoomTemplate | undefined {
  if (!id) return undefined;
  return ROOM_TEMPLATES.find(t => t.id === id);
}

export function roleLabelFor(roleId: string): string {
  return r(roleId)?.label ?? roleId;
}

export function localizedRoleLabel(roleId: string, locale: Locale): string {
  const preset = r(roleId);
  return preset ? translate(locale, `role.${preset.id}` as MessageKey) : roleId;
}

export function localizedTemplate(template: RoomTemplate, locale: Locale): RoomTemplate {
  const prefix = `template.${template.id}`;
  return {
    ...template,
    label: translate(locale, `${prefix}.label` as MessageKey),
    description: translate(locale, `${prefix}.description` as MessageKey),
    topicSeed: translate(locale, `${prefix}.topic` as MessageKey),
    openingMessage: translate(locale, `${prefix}.opening` as MessageKey),
  };
}

export function roleNameFor(roleId: string): string {
  return r(roleId)?.role ?? roleId;
}
