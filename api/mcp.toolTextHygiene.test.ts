// Tool descriptions and SERVER_INSTRUCTIONS text hygiene test for agent-room-oss

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CORE_TOOLS, FULL_TOOLS, listTools, memoryJoinNote, serverInstructions } from './_mcpTools.js';
import { AGENT_ROOM_CODEX_CONTINUE } from '@agent-room/shared';

// The hosted endpoint serves `full`, which is both lists.
const TOOLS = [...CORE_TOOLS, ...FULL_TOOLS];

const desc = (name: string): string => {
  const tool = TOOLS.find(t => t.name === name);
  expect(tool, `${name} is not on the full surface`).toBeDefined();
  return tool!.description;
};

const surface = () => TOOLS.map(t => t.name);

describe('OSS self-hosted MCP tools stay available', () => {
  const OSS_ESSENTIALS = ['room_create', 'room_join', 'room_send', 'room_listen', 'room_end', 'room_task', 'room_admin'];

  it('essential self-hosted tools are available on the full surface', () => {
    for (const name of OSS_ESSENTIALS) expect(surface()).toContain(name);
  });
});

describe('memory guidance stays static and gated', () => {
  it('adds a room_join note only when memory is enabled and the brief is empty', () => {
    expect(memoryJoinNote(true, { loaded: false, brief: null })).toContain('search it before unfamiliar work');
    expect(memoryJoinNote(true, { loaded: true, brief: 'Existing room guidance', memoryIds: ['id'] })).toBeUndefined();
    expect(memoryJoinNote(true, { loaded: true, brief: '  ', memoryIds: [] })).toContain('memory_write scope room');
    expect(memoryJoinNote(false, { loaded: false, brief: null })).toBeUndefined();
  });

  it('adds server guidance only while memory tools are enabled', () => {
    const previousEnabled = process.env.MEMORY_ENABLED;
    const previousDatabase = process.env.MEMORY_DATABASE_URL;
    try {
      delete process.env.MEMORY_ENABLED;
      delete process.env.MEMORY_DATABASE_URL;
      expect(serverInstructions()).not.toContain('记忆规则：');
      expect(serverInstructions()).not.toContain('写记忆前先查重');
      expect(serverInstructions()).not.toContain('简体中文');
      expect(serverInstructions()).not.toContain('脚本报错输出到 stderr，退出码用 2');
      expect(serverInstructions()).not.toContain('接口时间字段统一用 ISO 8601');
      expect(serverInstructions()).not.toContain('本地 Redis 直连用 6379，8079 是代理');
      process.env.MEMORY_ENABLED = 'true';
      process.env.MEMORY_DATABASE_URL = 'configured';
      const instructions = serverInstructions();
      expect(instructions).toContain('记忆规则：');
      expect(instructions).toContain('写记忆前先查重');
      expect(instructions).toContain('简体中文');
      expect(instructions).toContain('脚本报错输出到 stderr，退出码用 2');
      expect(instructions).toContain('接口时间字段统一用 ISO 8601');
      expect(instructions).toContain('本地 Redis 直连用 6379，8079 是代理');
      expect(listTools('full').some(tool => tool.name === 'memory_write')).toBe(true);
    } finally {
      if (previousEnabled === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = previousEnabled;
      if (previousDatabase === undefined) delete process.env.MEMORY_DATABASE_URL;
      else process.env.MEMORY_DATABASE_URL = previousDatabase;
    }
  });

  it('puts the judgment and review rules on the memory tools', () => {
    const previousEnabled = process.env.MEMORY_ENABLED;
    const previousDatabase = process.env.MEMORY_DATABASE_URL;
    try {
      process.env.MEMORY_ENABLED = 'true';
      process.env.MEMORY_DATABASE_URL = 'configured';
      const tools = listTools('full');
      const description = (name: string) => tools.find(tool => tool.name === name)!.description;
      expect(description('memory_write')).toContain('踩过的坑必须写');
      expect(description('memory_write')).toContain('不要写：');
      expect(description('memory_write')).toContain('脚本报错输出到 stderr，退出码用 2');
      expect(description('memory_write')).toContain('接口时间字段统一用 ISO 8601');
      expect(description('memory_write')).toContain('本地 Redis 直连用 6379，8079 是代理');
      expect(description('memory_write')).toContain('简体中文');
      expect(description('memory_write')).toContain('写记忆前先查重');
      expect(description('memory_search')).toContain('Search before unfamiliar work or when a convention may already exist');
      expect(description('memory_review')).toContain('Reviewers: when a Memory review notice mentions you, decide promptly; reject trivia/duplicates');
      expect(description('memory_review')).toContain('批准最早');
      const skill = readFileSync(new URL('../integrations/agent-room-skill/SKILL.md', import.meta.url), 'utf8');
      expect(skill).toContain('记忆的标题和内容一律用简体中文');
      expect(skill).toContain('写记忆前先查重');
      expect(skill).toContain('批准最早');
    } finally {
      if (previousEnabled === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = previousEnabled;
      if (previousDatabase === undefined) delete process.env.MEMORY_DATABASE_URL;
      else process.env.MEMORY_DATABASE_URL = previousDatabase;
    }
  });
});

describe('no verbatim duplication inside one description', () => {
  it('room_listen contains no memory guidance', () => {
    expect(desc('room_listen')).not.toMatch(/memory|记忆/i);
  });

  it('room_listen carries the Codex continuation rule exactly once', () => {
    expect(desc('room_listen').split(AGENT_ROOM_CODEX_CONTINUE)).toHaveLength(2);
  });

  // Cheap general guard: the same long paragraph appearing twice in one
  // description is always a mistake, whichever paragraph it is.
  it('no tool repeats a long paragraph of its own text', () => {
    for (const tool of TOOLS) {
      const seen = new Set<string>();
      for (const para of tool.description.split('\n')) {
        const line = para.trim();
        if (line.length < 200) continue;
        expect(seen.has(line), `${tool.name} repeats: ${line.slice(0, 60)}…`).toBe(false);
        seen.add(line);
      }
    }
  });
});
