# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public issue
2. Email the maintainers or open a private security advisory on GitHub
3. Include steps to reproduce and potential impact

## API Key Safety

This project uses the OpenAI API. Never commit your `.env` file or API keys to the repository. The `.gitignore` is configured to exclude `.env` files.

## Known Considerations

- Game state is stored in PostgreSQL — ensure your database is properly secured
- The OpenAI API key has access to your account's billing — keep it private
- Portrait generation (DALL-E) is opt-in and costs ~$0.04 per image
