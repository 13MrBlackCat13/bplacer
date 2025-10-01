# Contributing to bplacer

Thank you for your interest in contributing to bplacer! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Coding Guidelines](#coding-guidelines)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)

## Code of Conduct

- Be respectful and constructive in discussions
- Focus on what is best for the community and the project
- Show empathy towards other community members

## How Can I Contribute?

### Reporting Bugs

Before creating a bug report, please check existing issues to avoid duplicates. When creating a bug report, use the bug report template and include:

- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version, bplacer version)
- Relevant logs or screenshots

### Suggesting Features

Feature suggestions are welcome! Use the feature request template and clearly describe:

- The problem or limitation you're addressing
- Your proposed solution
- How it would benefit users
- Any implementation ideas you might have

### Code Contributions

1. **Fork the repository** and create a new branch from `main`
2. **Make your changes** following the coding guidelines
3. **Test thoroughly** - ensure your changes work with proxies, CF-Clearance, and different drawing modes
4. **Update documentation** if you're changing functionality
5. **Submit a pull request** with a clear description

## Development Setup

### Prerequisites

- Node.js 16+ and npm
- Python 3.8+ (for CF-Clearance-Scraper)
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/bplacer.git
cd bplacer

# Install Node.js dependencies
npm install

# Set up CF-Clearance-Scraper
git clone https://github.com/Xewdy444/CF-Clearance-Scraper CF-Clearance-Scraper
cd CF-Clearance-Scraper
pip install -r requirements.txt
cd ..

# Start the server
npm start
```

### Running the Application

```bash
# Development mode (default port 3002)
npm start

# Custom port
PORT=3000 node server.js
```

## Coding Guidelines

### JavaScript Style

- Use meaningful variable and function names
- Add comments for complex logic
- Follow existing code style and indentation (2 spaces)
- Use async/await instead of raw promises when possible
- Handle errors gracefully with try/catch blocks

### Key Principles

1. **Proxy Support** - All new HTTP requests should support proxy rotation via `MockImpit`
2. **CF-Clearance Integration** - Ensure new endpoints handle Cloudflare challenges properly
3. **Error Handling** - Log errors clearly and provide user-friendly error messages
4. **Resource Cleanup** - Always clean up timeouts, intervals, and event listeners
5. **Backward Compatibility** - Don't break existing templates or user configurations

### File Organization

- **server.js** - Main server, API routes, core classes (WPlacer, MockImpit, TemplateManager)
- **cf-clearance-manager.js** - CF token management
- **public/scripts/index.js** - Frontend logic
- **public/styles/index.css** - UI styling

## Commit Messages

Write clear, descriptive commit messages:

```
Add global error handler for JSON parsing errors

Fixes SyntaxError crashes when client sends malformed JSON.
The handler now catches these errors and returns a proper 400 response
instead of crashing the Express server.
```

Format:
- First line: Brief summary (50 chars or less)
- Blank line
- Detailed explanation of what and why (not how)

## Pull Request Process

1. **Update CHANGELOG.md** - Add your changes to the "Unreleased" section
2. **Ensure tests pass** - Test with multiple accounts, proxies, and templates
3. **Update documentation** - Update README.md or CLAUDE.md if needed
4. **Fill out PR template** - Describe what you changed and why
5. **Link related issues** - Reference any issues your PR addresses

### PR Checklist

- [ ] Code follows existing style guidelines
- [ ] Tested with proxies enabled/disabled
- [ ] Tested with CF-Clearance-Scraper
- [ ] No console errors or warnings
- [ ] CHANGELOG.md updated
- [ ] Documentation updated (if applicable)

## Testing

### Manual Testing Priorities

When testing your changes, ensure:

1. **Multi-account support** - Test with 3+ accounts simultaneously
2. **Proxy rotation** - Verify proxies rotate correctly under load
3. **CF-Clearance refresh** - Test auto-refresh on 403 errors
4. **Drawing modes** - Test at least 2-3 different modes (burst, radial, linear)
5. **Error handling** - Test with invalid inputs, network failures, expired tokens
6. **Template lifecycle** - Start, pause, resume, stop templates

### Test Scenarios

**User Management:**
- Add user via JWT token sync
- Import credentials from .txt file
- Delete user and verify template cleanup
- Refresh expired tokens

**Template Operations:**
- Create template with image upload
- Start template with multiple users
- Pause/resume during execution
- Change drawing modes mid-execution
- Handle 429 rate limits gracefully

**Proxy System:**
- Sequential vs random rotation
- Proxy quarantine on failures
- CF-Clearance with different proxies
- Fallback when no proxies available

## Questions?

If you have questions about contributing, feel free to:
- Open an issue with the "question" label
- Check existing discussions and issues
- Review CLAUDE.md for architecture details

Thank you for contributing to bplacer!
