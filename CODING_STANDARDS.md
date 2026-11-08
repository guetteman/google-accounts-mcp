# Coding standards

## Review rules

- Build every page people see from shadcn components, in the project's registry style and theme. Add a missing component with the shadcn CLI. Reject hand-made markup or styles that duplicate a shadcn component; a custom element needs a stated reason in the pull request.
- Adjust shadcn components only with the theme's tokens and Tailwind's scale (spacing, type size, weight, color). Reject hard-coded colors, sizes, or arbitrary values.
- Reject owner-specific values (Cloudflare account IDs, domains, email addresses, OAuth client IDs) in source code or committed configuration. They belong in the deploy's own configuration.
