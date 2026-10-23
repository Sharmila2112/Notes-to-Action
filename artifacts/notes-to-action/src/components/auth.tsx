import { useEffect, useState, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
// Replit's managed Clerk deployment system injects VITE_CLERK_PROXY_URL
// into production builds; setupClerkWhitelabelAuth only provisions the keys.
// Its absence from development secrets is intentional: dev uses Clerk directly.
// Keep this unconditional and do not replace it with a hardcoded proxy URL.
// See https://docs.replit.com/features/auth-and-identity/clerk-auth and
// .local/skills/clerk-auth/references/setup-and-customization.md (IMPORTANT).
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function PrivateSession({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, userId, sessionId } = useAuth();
  if (!isLoaded) return <main className="main-wrap" role="status">Loading your session…</main>;
  if (!userId) return <main className="main-wrap">
    <div className="eyebrow">Notes to Action</div>
    <h1 className="page-title">Your notes.<br />Your next steps.</h1>
    <p className="lede">Sign in to extract action items and access your private run history. Other visitors cannot view your notes or tasks.</p>
    <Link href="/sign-in" className="button-primary" data-testid="link-sign-in">Sign in</Link>{' '}
    <Link href="/sign-up" className="button-secondary">Create an account</Link>
  </main>;
  // A new cache and component tree for every identity/session prevents data
  // or pending mutation callbacks from carrying over when switching accounts.
  return <PrivateSession key={`${userId}:${sessionId}`}>{children}</PrivateSession>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/' : path;
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    signInFallbackRedirectUrl={basePath || '/'}
    signUpFallbackRedirectUrl={basePath || '/'}
    afterSignOutUrl={basePath || '/'}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    appearance={{
      theme: shadcn,
      cssLayerName: 'clerk',
      options: { logoImageUrl: `${window.location.origin}${basePath}/logo.svg`, logoLinkUrl: basePath || '/' },
      variables: {
        colorPrimary: '#365e50', colorForeground: '#26313b',
        colorMutedForeground: '#58636b', colorBackground: '#fcfaf6',
        colorInput: '#ffffff', colorInputForeground: '#26313b',
        colorDanger: '#b44039', colorNeutral: '#26313b',
        fontFamily: 'DM Sans, sans-serif',
      },
      elements: { cardBox: { backgroundColor: '#fcfaf6', width: '440px', maxWidth: '100%' } },
    }}
  >
    <Switch>
      <Route path="/sign-in/*?"><main className="main-wrap"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></main></Route>
      <Route path="/sign-up/*?"><main className="main-wrap"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></main></Route>
      <Route><AuthGate>{children}</AuthGate></Route>
    </Switch>
  </ClerkProvider>;
}
