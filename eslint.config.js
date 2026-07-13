import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
	{
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/out/**",
			"**/.test-tmp/**",
		],
	},
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			// TypeScript already reports undefined identifiers, and more
			// reliably - it understands ambient/runtime globals (Bun,
			// HTMLRewriter, ...) that ESLint's parser doesn't
			"no-undef": "off",
		},
	},
	eslintConfigPrettier
);
