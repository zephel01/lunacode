/**
 * TUI UIコンポーネント
 *
 * Phase 4.3: 高度なUI機能
 * - React Ink UI実装（TUI）
 * - ストリーミング表示
 * - インタラクティブモード
 *
 * 注意: React Inkを使用するためには、以下のパッケージが必要です：
 * - ink
 * - react
 * - @types/react
 *
 * インストール方法:
 * bun install ink react @types/react
 */

import React from 'react';
import { Box, Text, useApp, useStdout, useStdin as useInkStdin } from 'ink';

/**
 * UIの状態
 */
export interface UIState {
  mode: 'query' | 'interactive' | 'status';
  query: string;
  response: string;
  isProcessing: boolean;
  streaming: boolean;
  agentStatus: string;
  daemonStatus: string;
  memoryStats: any;
}

/**
 * TUIメインコンポーネント
 */
export function LunaCodeUI({ state, onQuery, onInteractive }: {
  state: UIState;
  onQuery: (query: string) => void;
  onInteractive: (input: string) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column">
      {/* ヘッダー */}
      <Header />

      {/* メインエリア */}
      <Box flexGrow={1}>
        {state.mode === 'query' && (
          <QueryMode
            state={state}
            onQuery={onQuery}
            width={columns}
          />
        )}

        {state.mode === 'interactive' && (
          <InteractiveMode
            state={state}
            onInput={onInteractive}
            width={columns}
          />
        )}

        {state.mode === 'status' && (
          <StatusMode
            state={state}
            width={columns}
          />
        )}
      </Box>

      {/* ステータスバー */}
      <StatusBar state={state} />
    </Box>
  );
}

/**
 * ヘッダーコンポーネント
 */
function Header() {
  return (
    <Box borderStyle="double" borderColor="green" padding={1}>
      <Text bold color="greenBright">
        🚀 LunaCode - KAIROS Autonomous Coding Agent
      </Text>
    </Box>
  );
}

/**
 * クエリモード
 */
function QueryMode({ state, onQuery, width }: {
  state: UIState;
  onQuery: (query: string) => void;
  width: number;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Query Mode</Text>
      <Box marginTop={1}>
        <Text color="dim">Enter your query below:</Text>
      </Box>
      <Input
        placeholder="Type your query..."
        onSubmit={onQuery}
        value={state.query}
        width={width - 4}
      />
    </Box>
  );
}

/**
 * インタラクティブモード
 */
function InteractiveMode({ state, onInput, width }: {
  state: UIState;
  onInput: (input: string) => void;
  width: number;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">Interactive Mode</Text>
      <Box marginTop={1} flexGrow={1} borderStyle="round" borderColor="blue" padding={1}>
        {state.isProcessing && (
          <Text color="yellow">Processing...</Text>
        )}

        {!state.isProcessing && state.response && (
          <Box flexDirection="column">
            <Text color="greenBright">✅ Response:</Text>
            <Text>{state.response}</Text>
          </Box>
        )}

        {state.streaming && (
          <StreamingContent content={state.response} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="dim">Interactive input (type 'exit' to quit):</Text>
      </Box>
      <Input
        placeholder="Type your input..."
        onSubmit={onInput}
        width={width - 4}
      />
    </Box>
  );
}

/**
 * ステータスモード
 */
function StatusMode({ state, width }: {
  state: UIState;
  width: number;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">Status Dashboard</Text>
      <Box marginTop={1} flexGrow={1}>
        <Box flexDirection="column">
          <AgentStatus status={state.agentStatus} />
          <DaemonStatus status={state.daemonStatus} />
          <MemoryStats stats={state.memoryStats} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * エージェントステータス
 */
function AgentStatus({ status }: { status: string }) {
  return (
    <Box borderStyle="single" borderColor="cyan" padding={1}>
      <Text bold color="cyan">Agent Status</Text>
      <Text>{status}</Text>
    </Box>
  );
}

/**
 * デーモンステータス
 */
function DaemonStatus({ status }: { status: string }) {
  return (
    <Box borderStyle="single" borderColor="blue" padding={1}>
      <Text bold color="blue">Daemon Status</Text>
      <Text>{status}</Text>
    </Box>
  );
}

/**
 * メモリ統計
 */
function MemoryStats({ stats }: { stats: any }) {
  if (!stats) {
    return <Text color="dim">Memory stats not available</Text>;
  }

  return (
    <Box borderStyle="single" borderColor="magenta" padding={1}>
      <Text bold color="magenta">Memory Statistics</Text>
      <Text>Lines: {stats.memoryLines || 0}</Text>
      <Text>Topics: {stats.topicCount || 0}</Text>
      <Text>Size: {((stats.totalSizeBytes || 0) / 1024).toFixed(2)} KB</Text>
    </Box>
  );
}

/**
 * ストリーミングコンテンツ
 */
function StreamingContent({ content }: { content: string }) {
  const [visibleContent, setVisibleContent] = React.useState('');

  React.useEffect(() => {
    let index = 0;
    const interval = setInterval(() => {
      if (index < content.length) {
        setVisibleContent(content.substring(0, index + 1));
        index++;
      } else {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [content]);

  return <Text color="yellowBright">{visibleContent}</Text>;
}

/**
 * ステータスバー
 */
function StatusBar({ state }: { state: UIState }) {
  return (
    <Box borderStyle="single" borderColor="white" paddingX={1}>
      <Text>
        {state.isProcessing && <Text color="yellow">⚙️ Processing...</Text>}
        {!state.isProcessing && <Text color="green">✓ Ready</Text>}
        {' | '}
        <Text color="dim">{state.mode.toUpperCase()}</Text>
        {' | '}
        {state.streaming && <Text color="yellow">📡 Streaming</Text>}
      </Text>
    </Box>
  );
}

/**
 * 入力コンポーネント
 */
function Input({ placeholder, onSubmit, value, width }: {
  placeholder: string;
  onSubmit: (value: string) => void;
  value: string;
  width: number;
}) {
  const { stdin, setRawMode } = useInkStdin();

  React.useEffect(() => {
    const handleInput = (data: string) => {
      process.stdout.write('\r' + ' '.repeat(width) + '\r');
      process.stdout.write(data);
    };

    stdin.on('data', handleInput);
    setRawMode(true);

    return () => {
      stdin.removeListener('data', handleInput);
      setRawMode(false);
    };
  }, [stdin, setRawMode, width]);

  return (
    <Box>
      <Text color="dim">{placeholder}</Text>
    </Box>
  );
}

/**
 * UIマネージャー
 */
export class UIManager {
  private state: UIState;
  private updateListeners: Set<(state: UIState) => void> = new Set();

  constructor() {
    this.state = {
      mode: 'query',
      query: '',
      response: '',
      isProcessing: false,
      streaming: false,
      agentStatus: 'Ready',
      daemonStatus: 'Stopped',
      memoryStats: null,
    };
  }

  /**
   * UIの開始
   */
  start(): void {
    console.log('🖥️ Starting TUI Interface...');

    // React Inkアプリケーションを起動
    const { render } = require('ink');

    const self = this;
    const App = () => {
      const [state, setState] = React.useState(self.state);

      const handleQuery = (query: string) => {
        this.state.query = query;
        this.state.mode = 'interactive';
        this.state.isProcessing = true;
        this.notifyListeners();
      };

      const handleInteractive = (input: string) => {
        if (input.toLowerCase() === 'exit') {
          this.state.mode = 'query';
          this.notifyListeners();
        } else {
          // インタラクティブ処理
        }
      };

      return React.createElement(LunaCodeUI, {
        state,
        onQuery: handleQuery,
        onInteractive: handleInteractive,
      });
    };

    render(React.createElement(App));
  }

  /**
   * 状態リスナーを追加
   */
  onUpdate(listener: (state: UIState) => void): () => void {
    this.updateListeners.add(listener);

    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /**
   * リスナーに通知
   */
  private notifyListeners(): void {
    for (const listener of this.updateListeners) {
      listener(this.state);
    }
  }

  /**
   * 状態を更新
   */
  updateState(updates: Partial<UIState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyListeners();
  }

  /**
   * クエリを設定
   */
  setQuery(query: string): void {
    this.updateState({ query, mode: 'query' });
  }

  /**
   * レスポンスを設定
   */
  setResponse(response: string): void {
    this.updateState({ response, isProcessing: false });
  }

  /**
   * ストリーミングを開始
   */
  startStreaming(): void {
    this.updateState({ streaming: true });
  }

  /**
   * ストリーミングを停止
   */
  stopStreaming(): void {
    this.updateState({ streaming: false });
  }

  /**
   * 処理状態を設定
   */
  setProcessing(isProcessing: boolean): void {
    this.updateState({ isProcessing });
  }

  /**
   * エージェントステータスを設定
   */
  setAgentStatus(status: string): void {
    this.updateState({ agentStatus: status });
  }

  /**
   * デーモンステータスを設定
   */
  setDaemonStatus(status: string): void {
    this.updateState({ daemonStatus: status });
  }

  /**
   * メモリ統計を設定
   */
  setMemoryStats(stats: any): void {
    this.updateState({ memoryStats: stats });
  }

  /**
   * モードを設定
   */
  setMode(mode: 'query' | 'interactive' | 'status'): void {
    this.updateState({ mode });
  }

  /**
   * 状態を取得
   */
  getState(): UIState {
    return { ...this.state };
  }
}

