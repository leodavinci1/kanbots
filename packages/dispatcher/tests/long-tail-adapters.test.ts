import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpAdapter, setAcpWorkspaceCommand } from '../src/adapters/acp.js';
import { ampCliAdapter } from '../src/adapters/amp-cli.js';
import { ccrCliAdapter } from '../src/adapters/ccr-cli.js';
import { copilotCliAdapter } from '../src/adapters/copilot-cli.js';
import { cursorCliAdapter } from '../src/adapters/cursor-cli.js';
import { droidCliAdapter } from '../src/adapters/droid-cli.js';
import { opencodeCliAdapter } from '../src/adapters/opencode-cli.js';
import { qwenCliAdapter } from '../src/adapters/qwen-cli.js';
import type { StreamEvent } from '../src/stream-parser.js';

function feed(lines: readonly string[], parse: (line: string) => StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const line of lines) {
    out.push(...parse(line));
  }
  return out;
}

describe('cursorCliAdapter', () => {
  it('builds the expected flags with --force and a default `auto` model', () => {
    const args = cursorCliAdapter.buildArgs({});
    expect(args).toContain('-p');
    expect(args).toContain('--output-format=stream-json');
    expect(args).toContain('--force');
    expect(args).toContain('--model');
    expect(args).toContain('auto');
  });

  it('parses system/assistant/tool_call/result into a normalized stream', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        session_id: 'sess-abc',
        model: 'gpt-5.4',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc-1',
        tool_call: { readToolCall: { args: { file_path: 'README.md' } } },
      }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc-1',
        tool_call: { readToolCall: { args: {}, result: 'hello' } },
      }),
      JSON.stringify({ type: 'result', is_error: false, duration_ms: 1234 }),
    ];
    const events = feed(lines, (l) => cursorCliAdapter.parseLine(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'text',
      'tool_use',
      'tool_result',
      'result',
    ]);
    const toolUse = events[2];
    expect(toolUse).toBeDefined();
    if (toolUse?.kind === 'tool_use') {
      expect(toolUse.name).toBe('Read');
      expect(toolUse.toolUseId).toBe('tc-1');
    }
  });

  it('drops thinking events', () => {
    const events = cursorCliAdapter.parseLine(
      JSON.stringify({ type: 'thinking', text: 'pondering' }),
    );
    expect(events).toHaveLength(0);
  });
});

describe('droidCliAdapter', () => {
  it('builds with --skip-permissions-unsafe by default', () => {
    const args = droidCliAdapter.buildArgs({});
    expect(args[0]).toBe('exec');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--skip-permissions-unsafe');
  });

  it('parses system/message/tool_call/tool_result/result events', () => {
    const lines = [
      JSON.stringify({ type: 'system', session_id: 'droid-1', model: 'droid-1' }),
      JSON.stringify({ type: 'message', role: 'assistant', text: 'hi' }),
      JSON.stringify({
        type: 'tool_call',
        id: 't-1',
        tool_name: 'Read',
        parameters: { file_path: 'a.txt' },
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 't-1',
        output: 'contents',
        is_error: false,
      }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        duration_ms: 100,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ];
    const events = feed(lines, (l) => droidCliAdapter.parseLine(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'text',
      'tool_use',
      'tool_result',
      'result',
    ]);
  });

  it('drops user/system message echoes (only assistant text becomes transcript)', () => {
    const events = droidCliAdapter.parseLine(
      JSON.stringify({ type: 'message', role: 'user', text: 'echo' }),
    );
    expect(events).toHaveLength(0);
  });
});

describe('opencodeCliAdapter', () => {
  it('builds with JSON output and permissive mode under the run subcommand', () => {
    const args = opencodeCliAdapter.buildArgs({});
    expect(args[0]).toBe('run');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--output-format=stream-json');
    expect(args).not.toContain('--auto-approve');
  });

  it('accepts assistant text in both raw-string and delta-shaped forms', () => {
    const raw = opencodeCliAdapter.parseLine(
      JSON.stringify({ type: 'assistant', text: 'hello world' }),
    );
    expect(raw.map((e) => e.kind)).toEqual(['text']);
    const delta = opencodeCliAdapter.parseLine(
      JSON.stringify({ type: 'assistant', text: { delta: 'streamed' } }),
    );
    expect(delta.map((e) => e.kind)).toEqual(['text']);
  });

  it('parses tool_use and tool_result with the alternate alias keys', () => {
    const tool = opencodeCliAdapter.parseLine(
      JSON.stringify({
        type: 'tool_call',
        id: 'op-1',
        tool: 'Edit',
        parameters: { file_path: 'x.ts' },
      }),
    );
    expect(tool.map((e) => e.kind)).toEqual(['tool_use']);
    const result = opencodeCliAdapter.parseLine(
      JSON.stringify({
        type: 'tool_response',
        tool_use_id: 'op-1',
        result: 'ok',
        is_error: false,
      }),
    );
    expect(result.map((e) => e.kind)).toEqual(['tool_result']);
  });

  it('parses stdout error events as failed results', () => {
    const events = opencodeCliAdapter.parseLine(
      JSON.stringify({
        type: 'error',
        error: {
          name: 'UnknownError',
          data: { message: 'Model not found: no/such.' },
        },
      }),
    );
    expect(events).toEqual([
      {
        kind: 'result',
        isError: true,
        text: 'Model not found: no/such.',
        tokenUsage: null,
        durationMs: null,
        totalCostUsd: null,
      },
    ]);
  });
});

describe('default model placeholders', () => {
  it('does not pass literal `default` as a model id to default-routed CLIs', () => {
    for (const adapter of [ampCliAdapter, opencodeCliAdapter, ccrCliAdapter, acpAdapter]) {
      const args = adapter.buildArgs({ model: 'default' });
      expect(args).not.toContain('--model');
      expect(args).not.toContain('default');
    }
  });
});

describe('qwenCliAdapter', () => {
  it('builds with --yolo', () => {
    const args = qwenCliAdapter.buildArgs({});
    expect(args).toContain('--yolo');
    expect(args).toContain('--output-format');
    expect(args).toContain('json-stream');
  });

  it('parses gemini-style stream events', () => {
    const lines = [
      JSON.stringify({ type: 'session', session_id: 'q-1', model: 'qwen3-coder-plus' }),
      JSON.stringify({ type: 'message', text: 'thinking through it' }),
      JSON.stringify({
        type: 'tool_use',
        id: 'tu-1',
        name: 'Read',
        input: { file_path: 'a.ts' },
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tu-1',
        output: 'file body',
        is_error: false,
      }),
      JSON.stringify({ type: 'result', exit_code: 0, duration_ms: 200 }),
    ];
    const events = feed(lines, (l) => qwenCliAdapter.parseLine(l));
    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'text',
      'tool_use',
      'tool_result',
      'result',
    ]);
  });
});

describe('ccrCliAdapter', () => {
  it('inherits claude-code flags under the `code` subcommand', () => {
    const args = ccrCliAdapter.buildArgs({});
    expect(args[0]).toBe('code');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });

  it('parses the standard Anthropic stream envelope (delegates to parseStreamLine)', () => {
    const events = ccrCliAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'reply' }] },
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['text']);
  });
});

describe('copilotCliAdapter + ACP parser', () => {
  it('spawns via npx with --acp and the permissive flag', () => {
    expect(copilotCliAdapter.command).toBe('npx');
    const args = copilotCliAdapter.buildArgs({});
    expect(args).toContain('-y');
    expect(args).toContain('@github/copilot');
    expect(args).toContain('--acp');
    expect(args).toContain('--allow-all-tools');
  });

  it('parses session/update notifications into text + tool events', () => {
    const lines = [
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          session_id: 's1',
          update: {
            type: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          session_id: 's1',
          update: {
            type: 'tool_call',
            tool_call_id: 'tc-acp',
            title: 'Bash',
            raw_input: { command: 'ls' },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          session_id: 's1',
          update: {
            type: 'tool_call_update',
            tool_call_id: 'tc-acp',
            fields: { status: 'completed', content: 'file1 file2' },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { stop_reason: 'end_turn' },
      }),
    ];
    const events = feed(lines, (l) => copilotCliAdapter.parseLine(l));
    expect(events.map((e) => e.kind)).toEqual(['text', 'tool_use', 'tool_result', 'result']);
  });
});

describe('acpAdapter', () => {
  const originalAcpCommand = process.env.KANBOTS_ACP_COMMAND;
  const originalAcpArgs = process.env.KANBOTS_ACP_ARGS;

  beforeEach(() => {
    delete process.env.KANBOTS_ACP_COMMAND;
    delete process.env.KANBOTS_ACP_ARGS;
    setAcpWorkspaceCommand(null);
  });

  afterEach(() => {
    if (originalAcpCommand === undefined) delete process.env.KANBOTS_ACP_COMMAND;
    else process.env.KANBOTS_ACP_COMMAND = originalAcpCommand;
    if (originalAcpArgs === undefined) delete process.env.KANBOTS_ACP_ARGS;
    else process.env.KANBOTS_ACP_ARGS = originalAcpArgs;
    setAcpWorkspaceCommand(null);
  });

  it('defaults to the gemini ACP server', () => {
    expect(acpAdapter.command).toBe('gemini');
    const args = acpAdapter.buildArgs({});
    expect(args).toContain('--experimental-acp');
    expect(args).toContain('--yolo');
  });

  it('prefers the workspace ACP command over the env/default command', () => {
    process.env.KANBOTS_ACP_COMMAND = 'env-agent --acp';
    setAcpWorkspaceCommand('workspace-agent --acp --yolo');

    expect(acpAdapter.command).toBe('workspace-agent');
    expect(acpAdapter.buildArgs({})).toEqual(['--acp', '--yolo']);
  });

  it('shares the ACP parser', () => {
    const events = acpAdapter.parseLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          session_id: 's1',
          update: {
            type: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['text']);
  });
});
