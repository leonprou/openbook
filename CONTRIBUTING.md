# Contributing to Claude Book

Thank you for your interest in contributing to Claude Book! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- AWS account with Rekognition access
- macOS with osxphotos (optional - only needed for Apple Photos integration)

### Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```
3. Copy the example config:
   ```bash
   cp config.example.yaml config.yaml
   ```
4. Set up AWS credentials (see README.md)
5. Run type checking:
   ```bash
   bun run typecheck
   ```

## Development Workflow

### Making Changes

1. Create a new branch for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following the project conventions:
   - Use TypeScript strict mode
   - Follow existing code style
   - Add type annotations for new functions
   - Update documentation if changing CLI commands

3. Test your changes:
   ```bash
   bun run start <command>
   bun run typecheck
   ```

4. Update documentation:
   - Update `docs/MANUAL.md` for CLI command changes
   - Update `docs/Architecture.md` for architectural changes
   - Update `README.md` for user-facing feature changes
   - Update `CLAUDE.md` for Claude-specific instructions

### Commit Guidelines

- Write clear, descriptive commit messages
- Use present tense ("Add feature" not "Added feature")
- Reference issues when applicable (#123)
- Keep commits focused on a single change

Examples:
```
Add --person filter to scan command
Fix HEIC conversion with sips fallback
Update documentation for new search methods
```

### Pull Request Process

1. Ensure your code passes type checking:
   ```bash
   bun run typecheck
   ```

2. Update the documentation as needed

3. Push your branch and create a pull request

4. In your PR description:
   - Describe what changed and why
   - Link to related issues
   - Include screenshots/examples if relevant

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── config.ts             # Configuration loading
├── db/                   # SQLite database
├── rekognition/          # AWS Rekognition wrapper
├── commands/             # CLI command implementations
├── pipeline/             # Photo scanning pipeline
└── export/               # Apple Photos export
```

## Code Style

- Follow TypeScript best practices
- Use meaningful variable names
- Add comments for complex logic
- Prefer async/await over promises
- Use strict null checks

## Testing

While we don't have formal unit tests yet, please:
- Test CLI commands manually with various options
- Verify edge cases (empty folders, invalid paths, etc.)
- Test with different image formats (JPEG, PNG, HEIC)
- Check AWS API error handling

## Areas for Contribution

### Good First Issues

- Add more helpful error messages
- Improve progress bar visibility
- Add validation for config values
- Enhance CLI output formatting

### Feature Ideas

- Support for additional photo sources (Google Photos, iCloud)
- Web UI for reviewing photos
- Batch training from multiple folders
- Export to other platforms besides Apple Photos
- Statistics and reporting features

### Documentation

- Add more examples to README
- Create troubleshooting guide
- Document AWS cost optimization tips
- Add video tutorials

## AWS Rekognition Considerations

When working with Rekognition:
- Keep API rate limits in mind (current: 5 req/sec)
- Test with small batches first (use `--limit`)
- Be aware of costs (see AWS pricing)
- Handle API errors gracefully

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Ask questions in issue discussions

## Code of Conduct

Please note that this project follows a Code of Conduct (see CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License

By contributing to Claude Book, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing!
