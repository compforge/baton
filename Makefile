.PHONY: install publish-baton-plugin

install:
	bun install
	bun link

publish-baton-plugin:
	bun run --cwd packages/plugin typecheck
	npm publish --workspace @compforge/baton-plugin --access public
