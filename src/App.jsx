import React from 'react';
import { ThemeProvider } from './context/ThemeContext';
import DashboardShell from './components/layout/DashboardShell';
import BusinessOwnerDashboard from './components/dashboard/BusinessOwnerDashboard';
import StoreManagerDashboard from './components/dashboard/StoreManagerDashboard';
import DataIngestionHub from './components/ingestion/DataIngestionHub';

export default function App() {
  return (
    <ThemeProvider>
      <DashboardShell>
        {(activeView, activeRole) => {
          switch (activeView) {
            case 'overview':
              return <BusinessOwnerDashboard activeRole={activeRole} />;
            case 'deep-analytics':
              return <StoreManagerDashboard activeRole={activeRole} />;
            case 'data-ingestion':
              return <DataIngestionHub />;
            default:
              return <BusinessOwnerDashboard activeRole={activeRole} />;
          }
        }}
      </DashboardShell>
    </ThemeProvider>
  );
}
