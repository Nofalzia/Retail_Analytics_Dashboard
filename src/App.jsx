import React from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginScreen from './components/auth/LoginScreen';
import DashboardShell from './components/layout/DashboardShell';
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

function AppContent() {
  const { isAuthenticated, user } = useAuth();
  const userName = (user?.email || '').split('@')[0] || 'there';

  // Gate the entire dashboard behind authentication.
  // LoginScreen handles its own styling — no DashboardShell wrapper needed.
  if (!isAuthenticated) return <LoginScreen />;

  return (
    <DashboardShell initialRole={ROLE_LABELS[user?.role] ?? 'Owner'} userName={userName}>
      {(activeView, activeRole, dataMode) => {
        const hasData = dataMode !== 'empty';
        // System Administrator is scoped to data ingestion only — no financial
        // data. Stockout Watch and Recommendations are operational views
        // accessible to all roles.
        if (
          activeRole === 'System Administrator' &&
          activeView !== 'stockout-prediction' &&
          activeView !== 'recommendations'
        ) {
          return <DataIngestionHub />;
        }

        switch (activeView) {
          case 'overview':
            return <BusinessOwnerDashboard activeRole={activeRole} hasData={hasData} dataMode={dataMode} />;
          case 'deep-analytics':
            return <StoreManagerDashboard activeRole={activeRole} hasData={hasData} dataMode={dataMode} />;
          case 'stockout-prediction':
            return <StockoutPrediction hasData={hasData} dataMode={dataMode} />;
          case 'recommendations':
            return <RecommendationsPanel hasData={hasData} dataMode={dataMode} />;
          case 'data-ingestion':
            return <DataIngestionHub />;
          default:
            return <BusinessOwnerDashboard activeRole={activeRole} hasData={hasData} dataMode={dataMode} />;
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
