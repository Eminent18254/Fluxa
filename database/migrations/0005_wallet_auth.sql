-- One-time challenges for wallet-signature authentication.
create table if not exists wallet_auth_challenges (
  nonce text primary key check (char_length(nonce) between 32 and 128),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists wallet_auth_challenges_expiry_idx
  on wallet_auth_challenges (expires_at);

alter table wallet_auth_challenges enable row level security;
revoke all on wallet_auth_challenges from anon, authenticated;
