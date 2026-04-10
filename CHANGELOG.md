# Changelog

All notable changes to LunaCode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Complete Phase 4 implementation
- Multi-agent coordination system
- Access control and user management
- Audit logging system
- Sandbox execution environment
- Modern TUI with React Ink
- Undercover Mode for commercial use
- Comprehensive documentation suite
- Enhanced CLI with all commands

### Changed

- Improved error handling across all components
- Optimized memory compaction algorithms
- Enhanced notification system with multiple channels
- Better parallel tool execution

### Fixed

- Fixed daemon process management issues
- Resolved memory corruption bugs
- Fixed notification timing issues
- Corrected type definitions

## [1.0.0] - 2026-04-10

### Added

- **Phase 0 Complete**: Basic agent loop with 7 core tools
- **Phase 1 Complete**: 3-tier self-healing memory system
- **Phase 2 Complete**: KAIROS daemon with AutoDream
- **Phase 3 Complete**: Parallel tools, notifications, Buddy mode
- **Phase 4 Complete**: Multi-agent, security, TUI, Undercover mode
- Multi-LLM provider support (OpenAI, Ollama, LM Studio, LiteLLM)
- React Ink-based TUI interface
- Comprehensive CLI with all commands
- Complete documentation suite

### Features

- **Agent System**: ReAct pattern (Thought → Action → Observation)
- **Memory System**: 3-tier architecture with compression
- **Daemon Mode**: 24/7 background processing
- **AutoDream**: Intelligent memory consolidation
- **Notification System**: OS, Pushover, Telegram support
- **Buddy Mode**: 18 AI pets with personality system
- **Multi-Agent**: Coordinator + Worker architecture
- **Security**: Access control, audit logging, sandbox
- **Undercover Mode**: Origin hiding for commercial use

### Providers

- OpenAI (recommended)
- Ollama (offline, free)
- LM Studio (offline, free)
- LiteLLM (unified interface)

### Documentation

- API Documentation
- Installation Guide
- User Guide
- Developer Guide
- FAQ
- Contributing Guide
- Architecture Documentation

### Breaking Changes

- None - Initial stable release

### Known Issues

- None - All major features implemented

## [0.9.0] - 2026-04-08

### Added

- Buddy mode implementation
- Notification system with OS support
- React Ink TUI components
- Multi-agent coordinator
- Access control system

### Changed

- Improved memory compression efficiency
- Enhanced daemon reliability
- Optimized tool execution

## [0.8.0] - 2026-04-05

### Added

- AutoDream implementation
- Daemon mode with tick system
- Parallel tool executor
- Notification manager

### Changed

- Refactored agent loop for better performance
- Improved memory context management

## [0.7.0] - 2026-04-02

### Added

- Memory compression algorithms
- Topic-based memory organization
- Auto-compact feature
- Search functionality

### Changed

- Enhanced tool system with more tools
- Improved error handling

## [0.6.0] - 2026-03-30

### Added

- Daemon mode basics
- Tick / Heartbeat system
- Proactive judgment system
- Event system

### Changed

- Restructured project for scalability
- Added configuration management

## [0.5.0] - 2026-03-25

### Added

- Basic agent loop implementation
- 7 core tools (Bash, File, Grep, Git, Edit, Search)
- Simple memory system
- CLI interface

### Changed

- Initial release

---

## Versioning

LunaCode follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create Git tag
4. Create GitHub release
5. Update documentation
6. Announce release

## Future Plans

See [plan.md](../plan.md) for upcoming features and roadmap.
