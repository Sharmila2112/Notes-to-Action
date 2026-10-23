import type { ReactNode } from 'react';

// Test-only SDK double. No imports from production code point to this file.
export const publishableKeyFromHost = () => 'offline-fixture';
export const ClerkProvider = ({ children }: { children: ReactNode }) => children;
export const useAuth = () => ({
  isLoaded: true,
  userId: localStorage.getItem('fixture-signed-out') ? null : 'fixture-owner',
  sessionId: 'fixture-session',
});
export const UserButton = () => <span aria-label="Fixture account" />;
export const SignIn = () => <div>Sign-in SDK fixture</div>;
export const SignUp = () => <div>Sign-up SDK fixture</div>;
