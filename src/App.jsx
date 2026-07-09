import React, { useState } from 'react';
import DashboardShell from './components/layout/DashboardShell';
import LaymanOverview from './components/dashboard/LaymanOverview';
import ManagerAnalytics from './components/dashboard/ManagerAnalytics';
import DataIngestionHub from './components/ingestion/DataIngestionHub';

export default function App() {
  // Must match the `id` values in DashboardShell's NAV_ITEMS, not the labels
  const [activeView, setActiveView] = useState('overview');

  const renderView = () => {
    switch (activeView) {
      case 'overview':
        return <LaymanOverview />;
      case 'deep-analytics':
        return <ManagerAnalytics />;
      case 'data-ingestion':
        return <DataIngestionHub />;
      default:
        return <LaymanOverview />;
    }
  };

  return (
    <DashboardShell activeView={activeView} onNavigate={setActiveView}>
      {renderView()}
    </DashboardShell>
  );
}