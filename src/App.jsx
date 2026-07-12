import React from 'react';
import { ThemeProvider } from './context/ThemeContext';
import DashboardShell from './components/layout/DashboardShell';
import BusinessOwnerDashboard from './components/dashboard/BusinessOwnerDashboard';
import StoreManagerDashboard from './components/dashboard/StoreManagerDashboard';
import DataIngestionHub from './components/ingestion/DataIngestionHub';
import StockoutPrediction from './components/dashboard/StockoutPrediction';
import RecommendationsPanel from './components/dashboard/RecommendationsPanel';

export default function App() {
  return (
    <ThemeProvider>
      <DashboardShell>
        {(activeView, activeRole) => {
          // System Administrator is scoped to data ingestion and stockout
          // visibility (no financial data) — but can still see Stockout Watch,
          // since it's real-world inventory context, not a financial metric.
          if (
            activeRole === 'System Administrator' &&
            activeView !== 'stockout-prediction' &&
            activeView !== 'recommendations'
          ) {
            return <DataIngestionHub />;
          }

          switch (activeView) {
            case 'overview':
              return <BusinessOwnerDashboard activeRole={activeRole} />;
            case 'deep-analytics':
              return <StoreManagerDashboard activeRole={activeRole} />;
            case 'stockout-prediction':
              return <StockoutPrediction />;
            case 'recommendations':
              return <RecommendationsPanel />;
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
