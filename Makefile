.PHONY: install test sync-npm-version publish-baton-plugin

TEST_FILES ?=
TEST_ARGS = $(if $(strip $(TEST_FILES)),$(TEST_FILES),tests)

install:
	bun install
	bun link

test:
	bun test $(TEST_ARGS)

sync-npm-version:
	bun scripts/sync-npm-version.ts

publish-baton-plugin:
	bun run --cwd packages/plugin typecheck
	npm publish --workspace @compforge/baton-plugin --access public
