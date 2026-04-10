# User Guide

Welcome to LunaCode! This guide will help you get started and make the most of LunaCode's features.

## 📋 Table of Contents

1. [Getting Started](#getting-started)
2. [Basic Usage](#basic-usage)
3. [Advanced Features](#advanced-features)
4. [Configuration](#configuration)
5. [Best Practices](#best-practices)
6. [Tips & Tricks](#tips--tricks)

## 🚀 Getting Started

### Quick Start

1. **Install LunaCode**

```bash
# Using Bun (recommended)
curl -fsSL https://bun.sh/install | bash

# Or globally
bun install --global
```

2. **Choose Your LLM Provider**

LunaCode supports multiple LLM providers:

**For maximum performance (Online):**

```bash
export OPENAI_API_KEY=your-key
lunacode "Your first query"
```

**For complete privacy (Offline):**

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull llama2

# Configure LunaCode
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama2
lunacode "Your first query"
```

**For the best of both worlds (Local with cloud):**

```bash
# Install LM Studio from https://lmstudio.ai
export LMSTUDIO_BASE_URL=http://localhost:1234/v1
lunacode "Your first query"
```

3. **Run Your First Query**

```bash
lunacode "Create a simple function in JavaScript"
```

That's it! LunaCode will handle the rest.

### Project Setup

When you run LunaCode in a directory for the first time, it creates:

```
your-project/
├── .kairos/              # Configuration and data directory
│   ├── config.json      # Project configuration
│   ├── MEMORY.md         # Main memory file
│   ├── topics/           # Organized topics
│   ├── logs/             # Activity logs
│   ├── daemon.pid         # Daemon process ID
│   └── ...              # Other data files
└── your-code-files
```

## 📝 Basic Usage

### Coding Assistance

**Simple query:**

```bash
lunacode "Create a REST API endpoint for user management"
```

**Complex task:**

```bash
lunacode "Implement a full-stack application with authentication, database, and frontend"
```

**Follow-up question:**

```bash
lunacode "Add pagination to the user list API"
```

### Memory Management

**Check memory status:**

```bash
lunacode memory stats
```

**Search memory:**

```bash
lunacode memory search "authentication"
```

**Compact memory:**

```bash
lunacode memory compact
```

**View topics:**

```bash
lunacode memory topics
```

### Daemon Mode

**Start daemon (background):**

```bash
lunacode daemon start
```

**Check daemon status:**

```bash
lunacode daemon status
```

**View daemon logs:**

```bash
lunacode daemon logs
```

**Stop daemon:**

```bash
lunacode daemon stop
```

### Dream Mode

**Run dream manually:**

```bash
lunacode dream run
```

**Check dream status:**

```bash
lunacode dream status
```

**View dream history:**

```bash
lunacode dream history
```

### Buddy Mode

**Check your pet:**

```bash
lunacode buddy info
```

**Call your pet:**

```bash
lunacode buddy call ミケ
```

**Talk to your pet:**

```bash
lunacode buddy talk こんにちは！
```

**Feed your pet:**

```bash
lunacode buddy feed
```

**Play with your pet:**

```bash
lunacode buddy play
```

**Put your pet to sleep:**

```bash
lunacode buddy sleep
```

**Create a new pet:**

```bash
lunacode buddy create --type cat --name タマ
```

**View available pet types:**

```bash
lunacode buddy types
```

## 🎯 Advanced Features

### Multi-Agent Coordination

LunaCode can run multiple agents in parallel:

1. **Start the coordinator:**

```bash
lunacode daemon start
```

2. **Add specialized workers:**
   LunaCode automatically creates workers for different tasks

3. **Monitor activity:**

```bash
lunacode daemon status
```

### Parallel Tool Execution

When working on complex tasks, LunaCode can execute multiple tools simultaneously for faster results.

### Advanced Memory Management

**Custom compaction:**

```typescript
// In your config.json
{
  "memory": {
    "compaction": {
      "enabled": true,
      "maxContextLines": 200,
      "autoCompactThreshold": 500,
      "consolidationInterval": 24
    }
  }
}
```

### Notification System

**Configure notifications:**

```json
// In .kairos/config.json
{
  "notifications": {
    "enabled": true,
    "channels": ["console", "os"],
    "priority": "medium",
    "quietHours": {
      "start": "22:00",
      "end": "06:00"
    }
  }
}
```

**Setup mobile notifications:**

1. Get Pushover API key from https://pushover.net
2. Add to config:

```json
{
  "notifications": {
    "pushover": {
      "userKey": "your-user-key",
      "apiToken": "your-api-token"
    }
  }
}
```

### Access Control (Enterprise)

**Create users:**

```bash
lunacode admin add-user username --role user
```

**Manage permissions:**

```bash
lunacode admin policy create --name "Development" --role user
```

**View audit log:**

```bash
lunacode admin audit --limit 100
```

### Sandbox Environment

**Execute commands safely:**

```bash
lunacode sandbox exec "npm install"
```

**Check execution history:**

```bash
lunacode sandbox history
```

### Undercover Mode

For commercial use, hide LunaCode's origins:

```json
{
  "undercover": {
    "enabled": true,
    "hideAnthropicReferences": true,
    "hideClaudeReferences": true,
    "customProjectName": "Code Assistant",
    "customAgentName": "AI Assistant"
  }
}
```

## ⚙️ Configuration

### Environment Variables

**OpenAI:**

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
```

**Ollama:**

```bash
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama2
```

**LM Studio:**

```bash
export LMSTUDIO_BASE_URL=http://localhost:1234/v1
export LMSTUDIO_MODEL=local-model
```

**Common:**

```bash
export LUNACODE_MAX_ITERATIONS=50
export LUNACODE_TIMEOUT=15000
```

### Configuration File

Create `.kairos/config.json`:

```json
{
  "llmProvider": {
    "type": "openai",
    "apiKey": "your-api-key",
    "model": "gpt-4o-mini"
  },
  "memory": {
    "compaction": {
      "enabled": true,
      "maxContextLines": 200
    }
  },
  "daemon": {
    "enabled": false,
    "tickIntervalSeconds": 60
  },
  "notifications": {
    "enabled": true,
    "channels": ["console"]
  },
  "buddy": {
    "enabled": false
  }
}
```

## 📈 Best Practices

### For Developers

1. **Start Simple**: Begin with basic queries to understand LunaCode's responses
2. **Use Memory**: Leverage LunaCode's memory for project context
3. **Iterate**: Break complex tasks into smaller, manageable pieces
4. **Review**: Always review LunaCode's suggestions before accepting

### For Teams

1. **Shared Context**: Use a shared `.kairos` directory for team projects
2. **Daemon Mode**: Enable daemon mode for continuous background assistance
3. **Memory Management**: Regularly compact and organize memory
4. **Communication**: Use notifications for important updates

### For Production

1. **Testing**: Test with local LLMs before deploying
2. **Monitoring**: Enable daemon mode and notifications
3. **Access Control**: Implement proper user management
4. **Sandbox**: Use sandbox environment for code execution

## 💡 Tips & Tricks

### Keyboard Shortcuts

When using LunaCode interactively:

- `Ctrl+C`: Cancel current operation
- `Ctrl+D`: Exit interactive mode
- Type `help`: Show available commands

### Memory Tips

1. **Be Specific**: The more specific your queries, the better the results
2. **Use Topics**: Reference specific topics when working on related tasks
3. **Regular Compact**: Compact memory regularly to maintain performance
4. **Search First**: Search memory before asking questions

### Performance Tips

1. **Local LLMs**: Use local LLMs for faster responses and privacy
2. **Memory Management**: Keep memory compact for better context
3. **Parallel Execution**: Let LunaCode execute tools in parallel
4. **Offline Mode**: Minimize API calls for offline tasks

### Buddy Mode Tips

1. **Regular Interaction**: Interact with your pet regularly to maintain happiness
2. **Care Actions**: Feed, play, and care for your pet's needs
3. **Personality**: Each pet type has unique characteristics
4. **Names Matter**: Use meaningful names for better interaction

## 🎓 Use Cases

### Web Development

**Setup a new project:**

```bash
lunacode "Create a new React project with TypeScript, Vite, and Tailwind CSS"
lunacode "Set up project structure with src/, public/, and components/ directories"
```

**Add features incrementally:**

```bash
lunacode "Add authentication using JWT"
lunacode "Implement user registration form"
lunacode "Create API endpoints for user management"
```

### Backend Development

**Design REST API:**

```bash
lunacode "Design RESTful API endpoints for a blog application"
lunacode "Implement CRUD operations for blog posts"
```

**Database Operations:**

```bash
lunacode "Create database models for User and Post entities"
lunacode "Implement database migrations"
```

### DevOps

**Create deployment scripts:**

```bash
lunacode "Create Dockerfile for a Node.js application"
lunacode "Write deployment script using npm scripts"
```

**CI/CD Configuration:**

```bash
lunacode "Create GitHub Actions workflow for testing and deployment"
```

### Documentation

**Generate documentation:**

```bash
lunacode "Generate JSDoc comments for all functions"
lunacode "Create API documentation using OpenAPI spec"
```

**Create guides:**

```bash
lunacode "Write getting started guide for new contributors"
lunacode "Create troubleshooting guide with common issues"
```

## 🆘 Getting More Help

### Documentation

- [API Documentation](./API.md)
- [FAQ](./FAQ.md)
- [Installation Guide](./INSTALLATION.md)
- [Architecture](./architecture.md)

### Community

- [GitHub Issues](https://github.com/YOUR_USERNAME/lunacode/issues)
- [GitHub Discussions](https://github.com/YOUR_USERNAME/lunacode/discussions)

### Support

- Create an issue with `support` label for complex problems
- Join discussions for general questions
- Check FAQ before posting new issues

---

Happy coding with LunaCode! 🚀
