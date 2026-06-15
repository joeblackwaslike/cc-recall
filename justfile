# List available recipes
default:
  @just --list

# Install dependencies and set up hooks
install:
  pnpm install

# Run all quality checks
check:
  pnpm typecheck && pnpm lint

# Run tests
test:
  pnpm test

# Run tests with coverage
test-coverage:
  pnpm test:coverage

# Build the project
build:
  pnpm build

# Clean build output
clean:
  rm -rf dist coverage


# Check for unused dependencies
deps:
  pnpm depcheck
