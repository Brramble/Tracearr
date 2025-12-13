import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Loader2, ExternalLink, User, KeyRound } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { api, tokenStorage, type PlexServerInfo, type Server, type Settings } from '@/lib/api';
import { LogoIcon } from '@/components/brand/Logo';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';

// Plex brand color
const PLEX_COLOR = 'bg-[#E5A00D] hover:bg-[#C88A0B]';

type AuthStep = 'initial' | 'plex-waiting' | 'server-select';

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading, refetch } = useAuth();

  // Setup status - default to false (Sign In mode) since most users are returning
  const [setupLoading, setSetupLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasPasswordAuth, setHasPasswordAuth] = useState(false);

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('initial');
  const [plexAuthUrl, setPlexAuthUrl] = useState<string | null>(null);
  const [plexServers, setPlexServers] = useState<PlexServerInfo[]>([]);
  const [plexTempToken, setPlexTempToken] = useState<string | null>(null);
  const [connectingToServer, setConnectingToServer] = useState<string | null>(null);
  const [plexPopup, setPlexPopup] = useState<ReturnType<typeof window.open>>(null);

  // Local auth state
  const [localLoading, setLocalLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');

  // Jellyfin auth state
  const [jellyfinLoading, setJellyfinLoading] = useState(false);
  const [jellyfinUsername, setJellyfinUsername] = useState('');
  const [jellyfinPassword, setJellyfinPassword] = useState('');
  const [jellyfinServers, setJellyfinServers] = useState<Server[]>([]);
  const [selectedJellyfinServer, setSelectedJellyfinServer] = useState<string>('');
  const [jellyfinAuthEnabled, setJellyfinAuthEnabled] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Check setup status on mount with retry logic for server restarts
  useEffect(() => {
    async function checkSetup() {
      const maxRetries = 3;
      const delays = [0, 1000, 2000]; // immediate, 1s, 2s

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          }
          const status = await api.setup.status();
          setNeedsSetup(status.needsSetup);
          setHasPasswordAuth(status.hasPasswordAuth);
          setJellyfinAuthEnabled(status.jellyfinAuthEnabled ?? false);
          setSetupLoading(false);
          return; // Success - exit retry loop
        } catch {
          // Continue to next retry attempt
        }
      }

      // All retries failed - server is unavailable
      // Default to Sign In mode (needsSetup: false) since most users are returning users
      // If they actually need setup, the server will tell them when it comes back
      setNeedsSetup(false);
      setSetupLoading(false);
    }
    void checkSetup();
  }, []);

  // Fetch Jellyfin servers after setup check
  useEffect(() => {
    async function fetchJellyfinServers() {
      if (setupLoading || needsSetup) {
        // Don't fetch during setup or initial loading
        setSettingsLoaded(true);
        return;
      }

      try {
        // Fetch servers list (public endpoint, no auth needed)
        const serversResult = await api.servers.list().catch(() => []);
        const jellyfinServersList = serversResult.filter((s: Server) => s.type === 'jellyfin');
        setJellyfinServers(jellyfinServersList);

        // Auto-select if only one Jellyfin server
        if (jellyfinServersList.length === 1) {
          setSelectedJellyfinServer(jellyfinServersList[0]!.id);
        }

        console.log('Jellyfin config:', {
          authEnabled: jellyfinAuthEnabled,
          serversCount: jellyfinServersList.length,
          servers: jellyfinServersList,
          needsSetup,
          shouldShow: !needsSetup && jellyfinAuthEnabled && jellyfinServersList.length > 0,
        });
      } catch {
        // Silently fail - not critical for login page
      } finally {
        setSettingsLoaded(true);
      }
    }

    void fetchJellyfinServers();
  }, [setupLoading, needsSetup, jellyfinAuthEnabled]);

  // Redirect if already authenticated
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      const redirectTo = searchParams.get('redirect') || '/';
      void navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, searchParams]);

  // Close Plex popup helper
  const closePlexPopup = () => {
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
  };

  // Poll for Plex PIN claim
  const pollPlexPin = async (pinId: string) => {
    try {
      const result = await api.auth.checkPlexPin(pinId);

      if (!result.authorized) {
        // Still waiting for PIN claim, continue polling
        setTimeout(() => void pollPlexPin(pinId), 2000);
        return;
      }

      // PIN claimed - close the popup
      closePlexPopup();

      // Check what we got back
      if (result.needsServerSelection && result.servers && result.tempToken) {
        // New user - needs to select a server
        setPlexServers(result.servers);
        setPlexTempToken(result.tempToken);
        setAuthStep('server-select');
      } else if (result.accessToken && result.refreshToken) {
        // User authenticated (returning or no servers)
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Logged in successfully!' });
        void navigate('/');
      }
    } catch (error) {
      resetPlexAuth();
      toast({
        title: 'Authentication failed',
        description: error instanceof Error ? error.message : 'Plex authentication failed',
        variant: 'destructive',
      });
    }
  };

  // Start Plex OAuth flow
  const handlePlexLogin = async () => {
    setAuthStep('plex-waiting');

    // Open popup to blank page first (same origin) - helps with cross-origin close
    const popup = window.open('about:blank', 'plex_auth', 'width=600,height=700,popup=yes');
    setPlexPopup(popup);

    try {
      // Pass callback URL so Plex redirects back to our domain after auth
      const callbackUrl = `${window.location.origin}/auth/plex-callback`;
      const result = await api.auth.loginPlex(callbackUrl);
      setPlexAuthUrl(result.authUrl);

      // Navigate popup to Plex auth
      if (popup && !popup.closed) {
        popup.location.href = result.authUrl;
      }

      // Start polling
      void pollPlexPin(result.pinId);
    } catch (error) {
      closePlexPopup();
      setAuthStep('initial');
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start Plex login',
        variant: 'destructive',
      });
    }
  };

  // Connect to selected Plex server
  const handlePlexServerSelect = async (serverUri: string, serverName: string, clientIdentifier: string) => {
    if (!plexTempToken) return;

    setConnectingToServer(serverName);

    try {
      const result = await api.auth.connectPlexServer({
        tempToken: plexTempToken,
        serverUri,
        serverName,
        clientIdentifier,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: `Connected to ${serverName}` });
        void navigate('/');
      }
    } catch (error) {
      setConnectingToServer(null);
      toast({
        title: 'Connection failed',
        description: error instanceof Error ? error.message : 'Failed to connect to server',
        variant: 'destructive',
      });
    }
  };

  // Reset Plex auth state
  const resetPlexAuth = () => {
    // Close popup if still open
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
    setAuthStep('initial');
    setPlexAuthUrl(null);
    setPlexServers([]);
    setPlexTempToken(null);
    setConnectingToServer(null);
  };

  // Handle local signup
  const handleLocalSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalLoading(true);

    try {
      const result = await api.auth.signup({
        email: email.trim(),
        username: username.trim(),
        password,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Account created successfully!' });
        void navigate('/');
      }
    } catch (error) {
      toast({
        title: 'Signup failed',
        description: error instanceof Error ? error.message : 'Failed to create account',
        variant: 'destructive',
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle local login
  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('LOCAL login handler called with:', { email: email.trim(), hasPassword: !!password });
    
    // Validate fields
    if (!email.trim() || !password) {
      toast({
        title: 'Validation error',
        description: 'Email and password are required',
        variant: 'destructive',
      });
      return;
    }
    
    setLocalLoading(true);

    try {
      const result = await api.auth.loginLocal({
        email: email.trim(),
        password,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Logged in successfully!' });
        void navigate('/');
      }
    } catch (error) {
      toast({
        title: 'Login failed',
        description: error instanceof Error ? error.message : 'Invalid email or password',
        variant: 'destructive',
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle Jellyfin login
  const handleJellyfinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Jellyfin login handler called with:', { 
      username: jellyfinUsername.trim(), 
      serverCount: jellyfinServers.length,
      serverId: jellyfinServers.length > 1 ? selectedJellyfinServer : undefined 
    });
    setJellyfinLoading(true);

    try {
      const result = await api.auth.loginJellyfin({
        username: jellyfinUsername.trim(),
        password: jellyfinPassword,
        serverId: jellyfinServers.length > 1 ? selectedJellyfinServer : undefined,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Logged in with Jellyfin!' });
        void navigate('/');
      }
    } catch (error) {
      toast({
        title: 'Jellyfin login failed',
        description: error instanceof Error ? error.message : 'Invalid credentials or insufficient permissions',
        variant: 'destructive',
      });
    } finally {
      setJellyfinLoading(false);
    }
  };

  // Show loading while checking auth/setup status
  if (authLoading || setupLoading || !settingsLoaded) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <LogoIcon className="h-16 w-16 animate-pulse" />
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Server selection step (only during Plex signup)
  if (authStep === 'server-select' && plexServers.length > 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="h-20 w-20 mb-4" />
          <h1 className="text-4xl font-bold tracking-tight">Tracearr</h1>
          <p className="mt-2 text-muted-foreground">Select your Plex server</p>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Select Server</CardTitle>
            <CardDescription>
              Choose which Plex Media Server to monitor
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PlexServerSelector
              servers={plexServers}
              onSelect={handlePlexServerSelect}
              connecting={connectingToServer !== null}
              connectingToServer={connectingToServer}
              onCancel={resetPlexAuth}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoIcon className="h-20 w-20 mb-4" />
        <h1 className="text-4xl font-bold tracking-tight">Tracearr</h1>
        <p className="mt-2 text-muted-foreground">
          {needsSetup
            ? 'Create your account to get started'
            : 'Sign in to your account'}
        </p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{needsSetup ? 'Create Account' : 'Sign In'}</CardTitle>
          <CardDescription>
            {needsSetup
              ? 'Create an account to manage your media servers'
              : 'Sign in to access your dashboard'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Plex OAuth Section */}
          {authStep === 'plex-waiting' ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-4 text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#E5A00D] mb-3" />
                <p className="text-sm font-medium">Waiting for Plex authorization...</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Complete sign-in in the popup window
                </p>
                {plexAuthUrl && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => window.open(plexAuthUrl, '_blank')}
                    className="gap-1 h-auto p-0 mt-2"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Reopen Plex Login
                  </Button>
                )}
              </div>
              <Button variant="ghost" className="w-full" onClick={resetPlexAuth}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              {/* Plex Login Button - Always Available */}
              <Button
                type="button"
                className={`w-full ${PLEX_COLOR} text-white`}
                onClick={handlePlexLogin}
              >
                <MediaServerIcon type="plex" className="mr-2 h-4 w-4" />
                {needsSetup ? 'Sign up with Plex' : 'Sign in with Plex'}
              </Button>

              {/* Jellyfin Login - Show only when enabled and servers exist */}
              {!needsSetup && jellyfinAuthEnabled && jellyfinServers.length > 0 && (
                <form onSubmit={handleJellyfinLogin} className="space-y-4 border-2 border-[#00A4DC] rounded-lg p-4">
                  <div className="text-sm font-semibold text-[#00A4DC] mb-2">Jellyfin Login</div>
                  <div className="space-y-2">
                    <Label htmlFor="jellyfin-username">Jellyfin Username</Label>
                    <Input
                      id="jellyfin-username"
                      type="text"
                      placeholder="Your Jellyfin username"
                      value={jellyfinUsername}
                      onChange={(e) => setJellyfinUsername(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="jellyfin-password">Jellyfin Password</Label>
                    <Input
                      id="jellyfin-password"
                      type="password"
                      placeholder="Your Jellyfin password"
                      value={jellyfinPassword}
                      onChange={(e) => setJellyfinPassword(e.target.value)}
                      required
                    />
                  </div>
                  {jellyfinServers.length > 1 && (
                    <div className="space-y-2">
                      <Label htmlFor="jellyfin-server">Jellyfin Server</Label>
                      <Select value={selectedJellyfinServer} onValueChange={setSelectedJellyfinServer} required>
                        <SelectTrigger id="jellyfin-server">
                          <SelectValue placeholder="Select a server" />
                        </SelectTrigger>
                        <SelectContent>
                          {jellyfinServers.map((server) => (
                            <SelectItem key={server.id} value={server.id}>
                              {server.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button
                    type="submit"
                    className="w-full bg-[#00A4DC] hover:bg-[#0080B8] text-white"
                    disabled={jellyfinLoading || (jellyfinServers.length > 1 && !selectedJellyfinServer)}
                  >
                    {jellyfinLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <MediaServerIcon type="jellyfin" className="mr-2 h-4 w-4" />
                    )}
                    Sign in with Jellyfin
                  </Button>
                </form>
              )}

              {/* Divider - Show if password auth is available OR during setup OR Jellyfin is enabled */}
              {((hasPasswordAuth || needsSetup) && (jellyfinAuthEnabled && jellyfinServers.length > 0)) && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
              )}

              {/* Local Auth Form */}
              {/* Signup form - only shown during initial setup */}
              {needsSetup ? (
                <form onSubmit={handleLocalSignup} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="username">Display Name</Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Choose a display name"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      minLength={3}
                      maxLength={50}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={localLoading}>
                    {localLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <User className="mr-2 h-4 w-4" />
                    )}
                    Create Account
                  </Button>
                </form>
              ) : hasPasswordAuth ? (
                <form onSubmit={handleLocalLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="text"
                      placeholder="your@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={localLoading}>
                    {localLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-4 w-4" />
                    )}
                    Sign In
                  </Button>
                </form>
              ) : null}

            </>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {needsSetup ? (
          <>
            After creating your account, you'll add your
            <br />
            Plex or Jellyfin servers from Settings.
          </>
        ) : (
          'Tracearr • Stream access management'
        )}
      </p>
    </div>
  );
}
