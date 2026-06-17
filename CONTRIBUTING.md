# Contributing to Cloud Connector

Thank you for your interest in contributing to the Cloud Connector! This
document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

Before submitting a bug report:

- Check the
  [existing issues](https://github.com/Serviceware/ai-process-engine-cloud-connector/issues)
  to avoid duplicates
- Collect information about the bug (logs, environment, steps to reproduce)

When submitting a bug report, include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- Environment details (Deno version, OS, etc.)
- Relevant logs or error messages

### Suggesting Features

Feature requests are welcome! Please:

- Check existing issues and discussions first
- Describe the problem your feature would solve
- Explain your proposed solution
- Consider alternatives you've thought about

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Install dependencies**: This project uses Deno, so ensure you have
   [Deno installed](https://deno.land/manual/getting_started/installation)
3. **Make your changes**: Follow our coding standards (see below)
4. **Write tests**: Add tests for new functionality
5. **Run checks**:
   ```bash
   deno task check  # Type checking
   deno task lint   # Linting
   deno task test   # Run tests
   ```
6. **Commit your changes**: Use clear, descriptive commit messages
7. **Submit a pull request**: Reference any related issues

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/ai-process-engine-cloud-connector.git
cd ai-process-engine-cloud-connector

# Run tests
deno task test

# Run type checking
deno task check

# Run linting
deno task lint

# Start development server
deno task dev
```

## Coding Standards

- **TypeScript**: All code should be written in TypeScript
- **Formatting**: Use Deno's built-in formatter (`deno fmt`)
- **Linting**: Ensure code passes `deno lint`
- **Testing**: Write tests for new features and bug fixes
- **Documentation**: Update documentation when changing public APIs

### Commit Messages

Use clear, descriptive commit messages:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test additions/changes
- `refactor:` for code refactoring
- `chore:` for maintenance tasks

Example: `feat(runtime): add support for YAML function definitions`

## Project Structure

```
├── runtime/          # Main runtime code
├── sdk/              # Cloud Connector SDK
├── templates/        # Starter templates and examples
├── docs/             # Documentation
├── openapi/          # OpenAPI specifications
└── schemas/          # JSON schemas
```

## Questions?

Feel free to open an issue for questions or reach out to the maintainers.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
