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
    </ThemeProvider>
  );
}