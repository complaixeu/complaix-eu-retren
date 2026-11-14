# Inbound fixtures (C4)

Fictional replies that carry our `[RTN-T100]` reference in the subject but **no** `In-Reply-To`
or `References` (an operator's ticketing system often starts a new thread). The integration test
rewrites `RTN-T100` to a seeded case. `Authentication-Results` is what Gmail adds on receipt; only
the topmost one is Gmail's own, so `ref-only-forged-auth.eml` hides a forged `dkim=pass` below it.
No real people, tickets, keys or signatures.
