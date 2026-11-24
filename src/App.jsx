import React from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginScreen from './components/auth/LoginScreen';
import DashboardShell from './components/layout/DashboardShell';
import CashierWorkspace from './components/cashier/CashierWorkspace';
import { readTokenClaims } from './utils/tokenClaims.js';
import BusinessOwnerDashboard from './components/dashboard/BusinessOwnerDashboard';
import StoreManagerDashboard from './components/dashboard/StoreManagerDashboard';
import DataIngestionHub from './components/ingestion/DataIngestionHub';
import StockoutPrediction from './components/dashboard/StockoutPrediction';
import RecommendationsPanel from './components/dashboard/RecommendationsPanel';

// ── Inner component — can use useAuth() because it sits inside AuthProvider ──
const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  data_entry_clerk: 'Data Entry Clerk',
  system_admin: 'System Administrator',
};

/**
 * API role for till-side accounts (see the role CHECK in backend/db/schema.sql).
 * They may upload files but may not read dashboards, so they get their own shell
 * instead of DashboardShell — no dashboard view is reachable from it.
 */
const TILL_ROLE = 'data_entry_clerk';

function AppContent() {
  const { isAuthenticated, user, token } = useAuth();

  // Gate the entire dashboard behind authentication.
  // LoginScreen handles its own styling — no DashboardShell wrapper needed.
  if (!isAuthenticated) return <LoginScreen />;

  // The user object lives in React state, so a refresh keeps the token but loses
  // the role. Read the role back off the token so the account always lands in the
  // shell that matches it — the server still re-checks every request.
  const role = user?.role ?? readTokenClaims(token)?.role ?? null;

  if (role === TILL_ROLE) return <CashierWorkspace />;

  return (
    <DashboardShell initialRole={ROLE_LABELS[role] ?? 'Owner'}>
      {(activeView, activeRole, dataMode, onOpenView) => {
        const hasData = true;
        // T9: the preview switcher only offers Owner and Manager, so there is no
        // System Administrator route left. Stockout Watch and Recommendations
        // remain operational views open to every role.

        switch (activeView) {
          case 'overview':
            return (
              <BusinessOwnerDashboard
                activeRole={activeRole}
                hasData={hasData}
                dataMode={dataMode}
                onOpenView={onOpenView}
              />
            );
          case 'deep-analytics':
            return (
              <StoreManagerDashboard
                activeRole={activeRole}
                hasData={hasData}
                dataMode={dataMode}
                onOpenView={onOpenView}
              />
            );
          case 'stockout-prediction':
            return <StockoutPrediction hasData={hasData} dataMode={dataMode} onOpenView={onOpenView} />;
          case 'recommendations':
            return <RecommendationsPanel hasData={hasData} dataMode={dataMode} onOpenView={onOpenView} />;
          case 'data-ingestion':
            // T12d: an import now ends with its analysis already run, so the hub
            // can send the user straight to the view that shows it.
            return (
              <DataIngestionHub
                dataMode={dataMode}
                onOpenView={onOpenView}
                onProceedToAnalytics={() => onOpenView('overview')}
              />
            );
          default:
            return (
              <BusinessOwnerDashboard
                activeRole={activeRole}
                hasData={hasData}
                dataMode={dataMode}
                onOpenView={onOpenView}
              />
            );
        }
      }}
    </DashboardShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}
