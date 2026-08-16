.PHONY: install test sync-npm-version publish-baton-plugin

install:
	bun install
	bun link

test:
	bun run test

sync-npm-version:
	bun scripts/sync-npm-version.ts

publish-baton-plugin:
	bun run --cwd packages/plugin typecheck
	npm publish --workspace @compforge/baton-plugin --access public
