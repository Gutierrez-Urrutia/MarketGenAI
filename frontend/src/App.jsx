import { Component, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Lock, LogIn, Mail, Sparkles } from "lucide-react";
import toast, { Toaster } from "react-hot-toast";
import { API_BASE_URL, authApi, authTokenStore, refreshAuthSession } from "./api/axios";
import Dashboard from "./Dashboard";
import { LanguageProvider, useLanguage } from "./context/LanguageContext";
import { ThemeProvider } from "./context/ThemeContext";
import { useI18n } from "./hooks/useI18n";

// Without this, any render-phase exception anywhere in the tree (e.g. while
// editing a proposal) unmounts the whole app and leaves a blank screen with
// no way to recover except a hard refresh. This surfaces the real error
// instead so it can be diagnosed and offers a way back without losing data.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: "" };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error:", error, info?.componentStack);
    this.setState({ componentStack: info?.componentStack || "" });
  }

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error?.message || String(this.state.error);
    const fullDetails = [message, this.state.error?.stack, this.state.componentStack]
      .filter(Boolean)
      .join("\n\n");
    return (
      <main className="min-h-screen bg-[#f7f6f2] text-neutral-900 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-2xl rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-red-700">Something went wrong</h1>
          <p className="mt-2 text-sm text-neutral-600">
            La aplicación encontró un error inesperado y no pudo seguir mostrando esta pantalla.
          </p>
          <pre className="mt-4 max-h-72 overflow-auto rounded-lg bg-neutral-50 p-3 text-xs text-neutral-700 whitespace-pre-wrap">
            {fullDetails}
          </pre>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-10 rounded-lg bg-[#6366f1] px-4 text-sm font-semibold text-white hover:bg-[#5558e8]"
            >
              Recargar
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(fullDetails)}
              className="h-10 rounded-lg border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Copiar error
            </button>
          </div>
        </div>
      </main>
    );
  }
}

const GLOBAL_TOAST_LIMIT = 3;
const GLOBAL_TOAST_OPTIONS = {
  duration: 5000,
  error: { duration: 8000 },
  success: { duration: 5000 },
  loading: { duration: 5000 },
};
const TOASTER_PROPS = {
  position: "top-right",
  toastOptions: GLOBAL_TOAST_OPTIONS,
};

if (!toast.__marketgenLimitPatched) {
  const activeToastIds = [];
  const wrapToastMethod = (method, duration) => {
    const original = toast[method]?.bind(toast);
    if (!original) return;
    toast[method] = (message, options = {}) => {
      const id = original(message, { duration, ...options });
      activeToastIds.push(id);
      while (activeToastIds.length > GLOBAL_TOAST_LIMIT) {
        toast.dismiss(activeToastIds.shift());
      }
      return id;
    };
  };
  wrapToastMethod("success", 5000);
  wrapToastMethod("error", 8000);
  wrapToastMethod("loading", 5000);
  toast.__marketgenLimitPatched = true;
}

const RESET_SUCCESS_KEY = "marketgen_reset_success";
const LEGACY_LOGIN_KEYS = [
  "marketgen_demo_session",
  "marketgen_registered_users",
  "rememberedEmail",
  "rememberedUser",
  "loginUser",
  "loginEmail",
  "username",
  "email",
  "password",
];
const DEMO_EMAIL = "admin@noondalton.com";
const DEMO_PASSWORD = "admin123";
const DEMO_LOGIN_ENABLED = import.meta.env.VITE_ENABLE_DEMO_LOGIN === "true";
const SHOW_DEMO_BANNER = import.meta.env.VITE_SHOW_DEMO_BANNER === "true";
const DEMO_AUTH_RESPONSE = {
  accessToken: "mock-access-token",
  refreshToken: "mock-refresh-token",
  user: {
    id: "demo-admin",
    name: "Admin User",
    email: DEMO_EMAIL,
    role: "admin",
    roles: ["admin"],
    demoMode: true,
  },
};
const DEMO_MODE_LABEL = {
  en: "Demo mode - not connected to real authentication API",
  es: "Modo demo - no conectado a la API real de autenticación",
  pt: "Modo demo - não conectado à API real de autenticação",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clearLegacyLoginStorage() {
  LEGACY_LOGIN_KEYS.forEach((key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
}

function fieldClass(hasError) {
  return `w-full h-10 rounded-lg border px-4 text-sm outline-none transition focus:ring-2 ${
    hasError
      ? "border-red-300 focus:border-red-500 focus:ring-red-500/20"
      : "border-neutral-300 focus:border-[#6366f1] focus:ring-[#6366f1]/20"
  }`;
}

function ForgotPasswordModal({ copy, onClose }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmedEmail = email.trim();

    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError(copy.invalidEmail);
      return;
    }

    setLoading(true);
    setError("");

    try {
      await authApi.forgotPassword({ email: trimmedEmail });
      toast.success(copy.resetSent);
      onClose();
    } catch (requestError) {
      setError(requestError.response?.data?.message || copy.resetError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-xl">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-neutral-900">{copy.forgotTitle}</h2>
          <p className="mt-1 text-sm text-neutral-600">{copy.forgotHelper}</p>
        </div>

        <label className="block text-sm font-medium text-neutral-800">
          <span className="mb-2 block">{copy.email}</span>
          <input
            className={fieldClass(Boolean(error))}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError("");
            }}
            type="email"
            autoComplete="email"
          />
        </label>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            disabled={loading}
          >
            {copy.cancel}
          </button>
          <button
            type="submit"
            className="h-10 rounded-lg bg-[#6366f1] px-4 text-sm font-semibold text-white hover:bg-[#5558e8] disabled:cursor-not-allowed disabled:opacity-70"
            disabled={loading}
          >
            {loading ? copy.sending : copy.sendReset}
          </button>
        </div>
      </form>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const { language, changeLanguage } = useLanguage();
  const { t } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const [mode, setMode] = useState("login");
  const [usernameOrEmail, setUsernameOrEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [loading, setLoading] = useState(false);
  const [authProvider, setAuthProvider] = useState("email");
  const [registerForm, setRegisterForm] = useState({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
    companyName: "",
    role: "",
  });
  const [forgotOpen, setForgotOpen] = useState(false);
  const usernameInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const rememberInputRef = useRef(null);

  const copy = useMemo(() => ({
    en: {
      signIn: "Sign in",
      signingIn: "Signing in...",
      helper: "Enter your credentials to continue",
      identity: "Username or email",
      password: "Password",
      remember: "Remember me",
      rememberHint: "Keep me signed in on this device",
      forgot: "Forgot your password?",
      identityRequired: "Enter your username or email.",
      passwordRequired: "Enter your password.",
      invalidLogin: "Invalid email or password",
      or: "or continue with",
      google: "Continue with Google",
      microsoft: "Continue with Microsoft",
      googleSignUp: "Sign up with Google",
      microsoftSignUp: "Sign up with Microsoft",
      googleNotConfigured: "Google authentication is not configured yet.",
      microsoftNotConfigured: "Microsoft authentication is not configured yet.",
      noAccount: "Don't have an account?",
      createAccount: "Create account",
      createAccountTitle: "Create account",
      createAccountHelper: "Set up your workspace access with email and password.",
      creatingAccount: "Creating account...",
      fullName: "Full name",
      confirmPassword: "Confirm password",
      companyName: "Company name",
      companyOptional: "Company name optional",
      role: "Role",
      roleOptional: "Role optional",
      backToSignIn: "Back to sign in",
      accountCreated: "Account created successfully",
      fullNameRequired: "Full name is required.",
      emailRequired: "Email is required.",
      passwordMin: "Password must be at least 8 characters.",
      passwordsDoNotMatch: "Passwords do not match.",
      emailAlreadyRegistered: "Email already registered.",
      signedIn: "Signed in successfully.",
      demoSignedIn: "Demo mode - not connected to real authentication API",
      forgotTitle: "Reset password",
      forgotHelper: "Enter your email and we will send a reset link.",
      email: "Email",
      invalidEmail: "Enter a valid email address.",
      sendReset: "Send reset link",
      sending: "Sending...",
      cancel: "Cancel",
      resetSent: "If the email exists, a reset link has been sent.",
      resetError: "We could not send the reset link. Please try again.",
    },
    es: {
      signIn: "Iniciar sesión",
      signingIn: "Iniciando sesión...",
      helper: "Ingresa tus credenciales para continuar",
      identity: "Nombre de usuario o correo",
      password: "Contraseña",
      remember: "Recordarme",
      rememberHint: "Mantener mi sesión iniciada en este dispositivo",
      forgot: "¿Olvidaste tu contraseña?",
      identityRequired: "Ingresa tu nombre de usuario o correo.",
      passwordRequired: "Ingresa tu contraseña.",
      invalidLogin: "Correo o contraseña inválidos.",
      or: "o continuar con",
      google: "Continuar con Google",
      microsoft: "Continuar con Microsoft",
      googleSignUp: "Registrarse con Google",
      microsoftSignUp: "Registrarse con Microsoft",
      googleNotConfigured: "La autenticación con Google aún no está configurada.",
      microsoftNotConfigured: "La autenticación con Microsoft aún no está configurada.",
      noAccount: "¿No tienes una cuenta?",
      createAccount: "Crear cuenta",
      createAccountTitle: "Crear cuenta",
      createAccountHelper: "Configura tu acceso con correo y contraseña.",
      creatingAccount: "Creando cuenta...",
      fullName: "Nombre completo",
      confirmPassword: "Confirmar contraseña",
      companyName: "Nombre de empresa",
      companyOptional: "Nombre de empresa opcional",
      role: "Rol",
      roleOptional: "Rol opcional",
      backToSignIn: "Volver a iniciar sesión",
      accountCreated: "Cuenta creada correctamente",
      fullNameRequired: "El nombre completo es obligatorio.",
      emailRequired: "El correo es obligatorio.",
      passwordMin: "La contraseña debe tener al menos 8 caracteres.",
      passwordsDoNotMatch: "Las contraseñas no coinciden.",
      emailAlreadyRegistered: "El correo ya está registrado.",
      signedIn: "Sesión iniciada correctamente.",
      demoSignedIn: "Modo demo - no conectado a la API real de autenticación",
      forgotTitle: "Recuperar contraseña",
      forgotHelper: "Ingresa tu correo y te enviaremos un enlace de recuperación.",
      email: "Correo",
      invalidEmail: "Ingresa un correo válido.",
      sendReset: "Enviar enlace",
      sending: "Enviando...",
      cancel: "Cancelar",
      resetSent: "Si el correo existe, se ha enviado un enlace de recuperación.",
      resetError: "No pudimos enviar el enlace. Intenta nuevamente.",
    },
    pt: {
      signIn: "Entrar",
      signingIn: "Entrando...",
      helper: "Insira suas credenciais para continuar",
      identity: "Nome de usuário ou e-mail",
      password: "Senha",
      remember: "Lembrar-me",
      rememberHint: "Manter minha sessão iniciada neste dispositivo",
      forgot: "Esqueceu sua senha?",
      identityRequired: "Insira seu nome de usuário ou e-mail.",
      passwordRequired: "Insira sua senha.",
      invalidLogin: "E-mail ou senha inválidos.",
      or: "ou continuar com",
      google: "Continuar com Google",
      microsoft: "Continuar com Microsoft",
      googleSignUp: "Inscrever-se com Google",
      microsoftSignUp: "Inscrever-se com Microsoft",
      googleNotConfigured: "A autenticação com Google ainda não está configurada.",
      microsoftNotConfigured: "A autenticação com Microsoft ainda não está configurada.",
      noAccount: "Não tem uma conta?",
      createAccount: "Criar conta",
      createAccountTitle: "Criar conta",
      createAccountHelper: "Configure seu acesso com e-mail e senha.",
      creatingAccount: "Criando conta...",
      fullName: "Nome completo",
      confirmPassword: "Confirmar senha",
      companyName: "Nome da empresa",
      companyOptional: "Nome da empresa opcional",
      role: "Cargo",
      roleOptional: "Cargo opcional",
      backToSignIn: "Voltar para entrar",
      accountCreated: "Conta criada com sucesso",
      fullNameRequired: "O nome completo é obrigatório.",
      emailRequired: "O e-mail é obrigatório.",
      passwordMin: "A senha deve ter pelo menos 8 caracteres.",
      passwordsDoNotMatch: "As senhas não coincidem.",
      emailAlreadyRegistered: "E-mail já registrado.",
      signedIn: "Sessão iniciada com sucesso.",
      demoSignedIn: "Modo demo - não conectado à API real de autenticação",
      forgotTitle: "Redefinir senha",
      forgotHelper: "Insira seu e-mail e enviaremos um link de redefinição.",
      email: "E-mail",
      invalidEmail: "Insira um e-mail válido.",
      sendReset: "Enviar link",
      sending: "Enviando...",
      cancel: "Cancelar",
      resetSent: "Se o e-mail existir, um link de redefinição foi enviado.",
      resetError: "Não foi possível enviar o link. Tente novamente.",
    },
  }[language]), [language]);

  useEffect(() => {
    clearLegacyLoginStorage();

    const clearAutofilledFields = () => {
      setUsernameOrEmail("");
      setPassword("");
      setRememberMe(false);

      if (usernameInputRef.current) usernameInputRef.current.value = "";
      if (passwordInputRef.current) passwordInputRef.current.value = "";
      if (rememberInputRef.current) rememberInputRef.current.checked = false;
    };

    clearAutofilledFields();
    requestAnimationFrame(clearAutofilledFields);
    const autofillCleanupTimer = window.setTimeout(clearAutofilledFields, 250);

    return () => window.clearTimeout(autofillCleanupTimer);
  }, []);

  useEffect(() => {
    const resetSuccess = sessionStorage.getItem(RESET_SUCCESS_KEY);
    if (resetSuccess) {
      sessionStorage.removeItem(RESET_SUCCESS_KEY);
      toast.success(resetSuccess);
    }
  }, []);

  const validate = () => {
    const nextErrors = {};
    if (!usernameOrEmail.trim()) nextErrors.usernameOrEmail = copy.identityRequired;
    if (!password) nextErrors.password = copy.passwordRequired;
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const updateRegisterField = (field, value) => {
    setRegisterForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((errors) => ({ ...errors, [field]: "" }));
    setFormError("");
  };

  const validateRegistration = () => {
    const nextErrors = {};
    const email = registerForm.email.trim().toLowerCase();

    if (!registerForm.fullName.trim()) nextErrors.fullName = copy.fullNameRequired;
    if (!email) nextErrors.email = copy.emailRequired;
    else if (!EMAIL_PATTERN.test(email)) nextErrors.email = copy.invalidEmail;
    if (!registerForm.password) nextErrors.password = copy.passwordRequired;
    else if (registerForm.password.length < 8) nextErrors.password = copy.passwordMin;
    if (registerForm.confirmPassword !== registerForm.password) nextErrors.confirmPassword = copy.passwordsDoNotMatch;

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError("");

    if (!validate()) return;

    setLoading(true);
    try {
      await authApi.login(
        { usernameOrEmail: usernameOrEmail.trim(), password },
        { remember: rememberMe },
      );
      toast.success(copy.signedIn);
      onLogin();
    } catch {
      const canUseDemoLogin =
        DEMO_LOGIN_ENABLED &&
        usernameOrEmail.trim().toLowerCase() === DEMO_EMAIL &&
        password === DEMO_PASSWORD;

      if (canUseDemoLogin) {
        authTokenStore.setTokens(DEMO_AUTH_RESPONSE, { remember: rememberMe });
        if (SHOW_DEMO_BANNER) {
          toast.success(copy.demoSignedIn);
        } else {
          console.info(copy.demoSignedIn);
        }
        onLogin();
        return;
      }

      setPassword("");
      setFormError(copy.invalidLogin);
      toast.error(copy.invalidLogin);
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (event) => {
    event.preventDefault();
    setFormError("");
    setAuthProvider("email");

    if (!validateRegistration()) return;

    const email = registerForm.email.trim().toLowerCase();
    setLoading(true);

    try {
      await authApi.register({
        name: registerForm.fullName.trim(),
        email,
        password: registerForm.password,
        company: registerForm.companyName.trim(),
        role: registerForm.role.trim(),
      }, { noSession: true });
    } catch (error) {
      const status = error.response?.status;
      if (status === 409) {
        setFieldErrors((errors) => ({ ...errors, email: copy.emailAlreadyRegistered }));
      } else {
        setFormError(error.response?.data?.detail?.message || copy.resetError);
      }
      setLoading(false);
      return;
    }

    toast.success(copy.accountCreated);
    setUsernameOrEmail(email);
    setPassword("");
    setRegisterForm({ fullName: "", email: "", password: "", confirmPassword: "", companyName: "", role: "" });
    setFieldErrors({});
    setMode("login");
    setLoading(false);
  };

  const handleAuthProvider = (provider) => {
    const providerKey = provider.toLowerCase();
    const configuredUrl = import.meta.env[`VITE_${provider.toUpperCase()}_AUTH_URL`];
    setAuthProvider(providerKey);

    if (configuredUrl) {
      window.location.assign(configuredUrl);
      return;
    }

    window.location.assign(`${API_BASE_URL}/auth/${providerKey}`);
  };

  const handleGoogleAuth = () => handleAuthProvider("Google");
  const handleMicrosoftAuth = () => handleAuthProvider("Microsoft");

  const showRegister = () => {
    setMode("register");
    setFieldErrors({});
    setFormError("");
    setPassword("");
  };

  const showLogin = () => {
    setMode("login");
    setFieldErrors({});
    setFormError("");
    setRegisterForm({ fullName: "", email: "", password: "", confirmPassword: "", companyName: "", role: "" });
  };
  const langLabels = {
    en: t("settings.englishLanguage"),
    es: t("settings.spanishLanguage"),
    pt: t("settings.portugueseLanguage"),
  };

  return (
    <main className="min-h-screen bg-[#f7f6f2] text-neutral-900 flex items-center justify-center px-4 py-8" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: 20, right: 24, zIndex: 50 }}>
        <button
          onClick={() => setLangOpen(prev => !prev)}
          style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 8, padding: '5px 12px', fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {language.toUpperCase()}
          <span style={{ fontSize: 10 }}>▼</span>
        </button>
        {langOpen && (
          <div style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,.08)', overflow: 'hidden', minWidth: 140 }}>
            {Object.entries(langLabels).map(([code, label]) => (
            <button
              key={code}
              onClick={() => { changeLanguage(code); setLangOpen(false); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', background: language === code ? '#f1f3f8' : 'none', border: 'none', fontSize: 13.5, fontWeight: language === code ? 700 : 400, color: language === code ? '#6366f1' : '#475569', cursor: 'pointer' }}
            >
              {label}
            </button>
            ))}
          </div>
        )}
      </div>
      <section className="w-full max-w-[462px]">
        <div className="flex flex-col items-center text-center mb-9">
          <div className="h-14 w-14 rounded-2xl bg-[#6366f1] text-white flex items-center justify-center shadow-sm">
            <Sparkles size={22} strokeWidth={2.2} />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-normal">NoonDalton</h1>
          <p className="mt-1 text-base text-neutral-600">AI Marketing Suite</p>
        </div>

        <form onSubmit={mode === "login" ? handleSubmit : handleRegisterSubmit} autoComplete="off" className="bg-white border border-neutral-200 rounded-xl shadow-sm px-9 py-8">
          <div className="mb-7">
            <h2 className="text-xl font-semibold">{mode === "login" ? copy.signIn : copy.createAccountTitle}</h2>
            <p className="mt-2 text-sm text-neutral-600">{mode === "login" ? copy.helper : copy.createAccountHelper}</p>
          </div>
          <input type="hidden" name="authProvider" value={authProvider} />

          {mode === "login" ? (
          <>
          <label className="block text-sm font-medium text-neutral-800 mb-5">
            <span className="flex items-center gap-2 mb-2">
              <Mail size={14} className="text-neutral-500" />
              {copy.identity}
            </span>
            <input
              ref={usernameInputRef}
              className={fieldClass(Boolean(fieldErrors.usernameOrEmail))}
              value={usernameOrEmail}
              onChange={(event) => {
                setUsernameOrEmail(event.target.value);
                setFieldErrors((errors) => ({ ...errors, usernameOrEmail: "" }));
                setFormError("");
              }}
              type="text"
              name="nd-login-user"
              autoComplete="off"
              placeholder={copy.identity}
              aria-invalid={Boolean(fieldErrors.usernameOrEmail)}
            />
            {fieldErrors.usernameOrEmail && <span className="mt-2 block text-sm text-red-600">{fieldErrors.usernameOrEmail}</span>}
          </label>

          <label className="block text-sm font-medium text-neutral-800 mb-6">
            <span className="flex items-center gap-2 mb-2">
              <Lock size={14} className="text-neutral-500" />
              {copy.password}
            </span>
            <span className="relative block">
              <input
                ref={passwordInputRef}
                className={`${fieldClass(Boolean(fieldErrors.password))} no-password-reveal pr-12`}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFieldErrors((errors) => ({ ...errors, password: "" }));
                  setFormError("");
                }}
                type={showPassword ? "text" : "password"}
                name="nd-login-pass"
                autoComplete="new-password"
                placeholder={copy.password}
                aria-invalid={Boolean(fieldErrors.password)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            {fieldErrors.password && <span className="mt-2 block text-sm text-red-600">{fieldErrors.password}</span>}
          </label>

          <div className="flex items-start justify-between gap-4 mb-6 text-sm">
            <div>
              <label className="flex items-center gap-2 text-neutral-600">
                <input
                  ref={rememberInputRef}
                  className="h-4 w-4 rounded border-neutral-300 text-[#6366f1] focus:ring-[#6366f1]"
                  type="checkbox"
                  name="nd-login-remember"
                  autoComplete="off"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                {copy.remember}
              </label>
              <p className="mt-1 pl-6 text-xs text-neutral-500">{copy.rememberHint}</p>
            </div>
            <button type="button" onClick={() => setForgotOpen(true)} className="text-[#6366f1] hover:text-[#4f46e5]">
              {copy.forgot}
            </button>
          </div>

          {formError && (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}

          <button
            className="w-full h-11 rounded-lg bg-[#6366f1] text-white font-semibold text-sm flex items-center justify-center gap-2 transition hover:bg-[#5558e8] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 disabled:cursor-not-allowed disabled:opacity-70"
            type="submit"
            disabled={loading}
          >
            <LogIn size={15} />
            {loading ? copy.signingIn : copy.signIn}
          </button>

          <div className="flex items-center gap-3 my-6 text-sm text-neutral-500">
            <span className="h-px flex-1 bg-neutral-200" />
            <span>{copy.or}</span>
            <span className="h-px flex-1 bg-neutral-200" />
          </div>

          <button
            className="w-full h-11 rounded-lg border border-neutral-300 bg-[#fbfaf7] text-neutral-800 font-medium text-sm flex items-center justify-center gap-3 transition hover:bg-neutral-50"
            type="button"
            onClick={handleGoogleAuth}
          >
            <span className="text-lg font-bold text-[#4285f4]">G</span>
            {copy.google}
          </button>

          <button
            className="mt-3 w-full h-11 rounded-lg border border-neutral-300 bg-[#fbfaf7] text-neutral-800 font-medium text-sm flex items-center justify-center gap-3 transition hover:bg-neutral-50"
            type="button"
            onClick={handleMicrosoftAuth}
          >
            <svg width="18" height="18" viewBox="0 0 21 21">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            {copy.microsoft}
          </button>

          <p className="mt-5 text-center text-sm text-neutral-600">
            {copy.noAccount}{" "}
            <button type="button" onClick={showRegister} className="font-semibold text-[#6366f1] hover:text-[#4f46e5]">
              {copy.createAccount}
            </button>
          </p>
          </>
          ) : (
          <>
            <label className="block text-sm font-medium text-neutral-800 mb-5">
              <span className="mb-2 block">{copy.fullName}</span>
              <input
                className={fieldClass(Boolean(fieldErrors.fullName))}
                value={registerForm.fullName}
                onChange={(event) => updateRegisterField("fullName", event.target.value)}
                type="text"
                autoComplete="name"
                placeholder={copy.fullName}
                aria-invalid={Boolean(fieldErrors.fullName)}
              />
              {fieldErrors.fullName && <span className="mt-2 block text-sm text-red-600">{fieldErrors.fullName}</span>}
            </label>

            <label className="block text-sm font-medium text-neutral-800 mb-5">
              <span className="mb-2 block">{copy.email}</span>
              <input
                className={fieldClass(Boolean(fieldErrors.email))}
                value={registerForm.email}
                onChange={(event) => updateRegisterField("email", event.target.value)}
                type="email"
                autoComplete="email"
                placeholder={copy.email}
                aria-invalid={Boolean(fieldErrors.email)}
              />
              {fieldErrors.email && <span className="mt-2 block text-sm text-red-600">{fieldErrors.email}</span>}
            </label>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="block text-sm font-medium text-neutral-800">
                <span className="mb-2 block">{copy.password}</span>
                <span className="relative block">
                  <input
                    className={`${fieldClass(Boolean(fieldErrors.password))} no-password-reveal pr-12`}
                    value={registerForm.password}
                    onChange={(event) => updateRegisterField("password", event.target.value)}
                    type={showRegisterPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={copy.password}
                    aria-invalid={Boolean(fieldErrors.password)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegisterPassword((value) => !value)}
                    className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
                    aria-label={showRegisterPassword ? "Hide password" : "Show password"}
                  >
                    {showRegisterPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
                {fieldErrors.password && <span className="mt-2 block text-sm text-red-600">{fieldErrors.password}</span>}
              </label>

              <label className="block text-sm font-medium text-neutral-800">
                <span className="mb-2 block">{copy.confirmPassword}</span>
                <input
                  className={`${fieldClass(Boolean(fieldErrors.confirmPassword))} no-password-reveal`}
                  value={registerForm.confirmPassword}
                  onChange={(event) => updateRegisterField("confirmPassword", event.target.value)}
                  type={showRegisterPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={copy.confirmPassword}
                  aria-invalid={Boolean(fieldErrors.confirmPassword)}
                />
                {fieldErrors.confirmPassword && <span className="mt-2 block text-sm text-red-600">{fieldErrors.confirmPassword}</span>}
              </label>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="block text-sm font-medium text-neutral-800">
                <span className="mb-2 block">{copy.companyOptional}</span>
                <input
                  className={fieldClass(false)}
                  value={registerForm.companyName}
                  onChange={(event) => updateRegisterField("companyName", event.target.value)}
                  type="text"
                  autoComplete="organization"
                  placeholder={copy.companyName}
                />
              </label>

              <label className="block text-sm font-medium text-neutral-800">
                <span className="mb-2 block">{copy.roleOptional}</span>
                <input
                  className={fieldClass(false)}
                  value={registerForm.role}
                  onChange={(event) => updateRegisterField("role", event.target.value)}
                  type="text"
                  autoComplete="organization-title"
                  placeholder={copy.role}
                />
              </label>
            </div>

            {formError && (
              <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {formError}
              </p>
            )}

            <button
              className="mt-6 w-full h-11 rounded-lg bg-[#6366f1] text-white font-semibold text-sm flex items-center justify-center gap-2 transition hover:bg-[#5558e8] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 disabled:cursor-not-allowed disabled:opacity-70"
              type="submit"
              disabled={loading}
            >
              <LogIn size={15} />
              {loading ? copy.creatingAccount : copy.createAccount}
            </button>

            <div className="flex items-center gap-3 my-6 text-sm text-neutral-500">
              <span className="h-px flex-1 bg-neutral-200" />
              <span>{copy.or}</span>
              <span className="h-px flex-1 bg-neutral-200" />
            </div>

            <button
              className="w-full h-11 rounded-lg border border-neutral-300 bg-[#fbfaf7] text-neutral-800 font-medium text-sm flex items-center justify-center gap-3 transition hover:bg-neutral-50"
              type="button"
              onClick={handleGoogleAuth}
              disabled={loading}
            >
              <span className="text-lg font-bold text-[#4285f4]">G</span>
              {copy.googleSignUp}
            </button>

            <button
              className="mt-3 w-full h-11 rounded-lg border border-neutral-300 bg-[#fbfaf7] text-neutral-800 font-medium text-sm flex items-center justify-center gap-3 transition hover:bg-neutral-50"
              type="button"
              onClick={handleMicrosoftAuth}
              disabled={loading}
            >
              <svg width="18" height="18" viewBox="0 0 21 21">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              {copy.microsoftSignUp}
            </button>

            <button type="button" onClick={showLogin} className="mt-5 w-full text-center text-sm font-semibold text-[#6366f1] hover:text-[#4f46e5]">
              {copy.backToSignIn}
            </button>
          </>
          )}
        </form>

      </section>

      {forgotOpen && <ForgotPasswordModal copy={copy} onClose={() => setForgotOpen(false)} />}
    </main>
  );
}

function ResetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const token = new URLSearchParams(window.location.search).get("token") || "";

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!token) {
      setError("Reset token is missing.");
      return;
    }

    if (!password || !confirmPassword) {
      setError("Enter and confirm your new password.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await authApi.resetPassword({ token, password });
      sessionStorage.setItem(RESET_SUCCESS_KEY, "Password updated successfully. Please sign in.");
      onDone();
    } catch (requestError) {
      setError(requestError.response?.data?.message || "We could not update your password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f7f6f2] text-neutral-900 flex items-center justify-center px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-[420px] rounded-xl border border-neutral-200 bg-white px-8 py-7 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#6366f1] text-white">
            <Lock size={20} />
          </div>
          <h1 className="text-xl font-semibold">Reset password</h1>
          <p className="mt-2 text-sm text-neutral-600">Choose a new password for your account.</p>
        </div>

        <label className="mb-5 block text-sm font-medium text-neutral-800">
          <span className="mb-2 block">New password</span>
          <span className="relative block">
            <input
              className={`${fieldClass(false)} no-password-reveal pr-10`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </label>

        <label className="mb-5 block text-sm font-medium text-neutral-800">
          <span className="mb-2 block">Confirm password</span>
          <input
            className={fieldClass(false)}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
          />
        </label>

        {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="h-11 w-full rounded-lg bg-[#6366f1] text-sm font-semibold text-white hover:bg-[#5558e8] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? "Updating..." : "Update password"}
        </button>
      </form>
    </main>
  );
}

function App() {
  const { language } = useLanguage();
  const [authState, setAuthState] = useState("checking");
  const path = window.location.pathname;

  const goToLogin = () => {
    window.history.replaceState({}, "", "/login");
    setAuthState("guest");
  };

  const goToDashboard = () => {
    window.history.replaceState({}, "", "/dashboard");
    setAuthState("authenticated");
  };

  // Linking a social account (Settings) redirects back here with
  // ?social_connected=facebook or ?social_error=... — unlike the
  // oauth_* params above, this doesn't touch login/session state, it just
  // needs a toast and the URL cleaned up.
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const socialConnected = urlParams.get("social_connected");
    const socialError = urlParams.get("social_error");
    if (!socialConnected && !socialError) return;

    if (socialConnected) {
      toast.success(`${socialConnected.charAt(0).toUpperCase()}${socialConnected.slice(1)} account connected.`);
    } else {
      const socialErrorMessages = {
        facebook_denied: "Facebook connection cancelled.",
        facebook_token_failed: "Could not authenticate with Facebook. Please try again.",
        facebook_no_pages: "No Facebook Page found on this account. Create or get access to a Page first.",
        facebook_server_error: "Internal error connecting to Facebook.",
      };
      toast.error(socialErrorMessages[socialError] || "Could not connect this social account.");
    }

    urlParams.delete("social_connected");
    urlParams.delete("social_error");
    const remaining = urlParams.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${remaining ? `?${remaining}` : ""}`);
  }, []);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      if (path === "/reset-password") {
        if (active) setAuthState("guest");
        return;
      }

      // Handle OAuth callback: Google/Microsoft redirect back with tokens in URL
      const urlParams = new URLSearchParams(window.location.search);
      const oauthAccessToken = urlParams.get("oauth_access_token");
      const oauthError = urlParams.get("oauth_error");

      if (oauthError) {
        window.history.replaceState({}, "", "/login");
        if (active) setAuthState("guest");
        const errorMessages = {
          google_denied: "Inicio de sesión con Google cancelado.",
          microsoft_denied: "Inicio de sesión con Microsoft cancelado.",
          google_token_failed: "Error al autenticar con Google. Intenta de nuevo.",
          microsoft_token_failed: "Error al autenticar con Microsoft. Intenta de nuevo.",
          google_no_email: "No se pudo obtener el email de tu cuenta Google.",
          microsoft_no_email: "No se pudo obtener el email de tu cuenta Microsoft.",
          google_server_error: "Error interno al iniciar sesión con Google. Revisa los logs del servidor.",
          microsoft_server_error: "Error interno al iniciar sesión con Microsoft. Revisa los logs del servidor.",
        };
        toast.error(errorMessages[oauthError] || "Error de autenticación social.");
        return;
      }

      if (oauthAccessToken) {
        const refreshToken = urlParams.get("oauth_refresh_token") || "";
        const expiresIn = Number(urlParams.get("oauth_expires_in")) || 1800;
        let user = null;
        try {
          user = JSON.parse(atob(urlParams.get("oauth_user") || ""));
        } catch {
          user = null;
        }
        authTokenStore.setTokens({ accessToken: oauthAccessToken, refreshToken, expiresIn, user });
        window.history.replaceState({}, "", "/dashboard");
        if (active) setAuthState("authenticated");
        return;
      }

      if (authTokenStore.isAccessTokenValid()) {
        if (active) setAuthState("authenticated");
        if (path === "/" || path === "/login") window.history.replaceState({}, "", "/dashboard");
        return;
      }

      if (authTokenStore.getRefreshToken()) {
        const refreshed = await refreshAuthSession();
        if (!active) return;

        if (refreshed) {
          setAuthState("authenticated");
          if (path === "/" || path === "/login") window.history.replaceState({}, "", "/dashboard");
          return;
        }
      }

      authTokenStore.clear();
      if (active) setAuthState("guest");
      if (path !== "/" && path !== "/login") window.history.replaceState({}, "", "/login");
    }

    checkSession();

    return () => {
      active = false;
    };
  }, [path]);

  if (authState === "checking") {
    return (
      <>
        <Toaster {...TOASTER_PROPS} />
        <main className="min-h-screen bg-[#f7f6f2] text-neutral-700 flex items-center justify-center">
          <p className="text-sm font-medium">Checking session...</p>
        </main>
      </>
    );
  }

  if (path === "/reset-password") {
    return (
      <>
        <Toaster {...TOASTER_PROPS} />
        <ResetPasswordScreen onDone={goToLogin} />
      </>
    );
  }

  if (authState !== "authenticated") {
    return (
      <>
        <Toaster {...TOASTER_PROPS} />
        <LoginScreen onLogin={goToDashboard} />
      </>
    );
  }

  return (
    <>
      <Toaster {...TOASTER_PROPS} />
      {SHOW_DEMO_BANNER && authTokenStore.getUser()?.demoMode && (
        <div className="fixed right-4 top-4 z-50 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 shadow-sm">
          {DEMO_MODE_LABEL[language]}
        </div>
      )}
      <Dashboard />
    </>
  );
}

export default function AppWithProviders() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </LanguageProvider>
    </ErrorBoundary>
  );
}
