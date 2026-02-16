// ─── Portfolio Performance Chart ───────────────────────────────────
let portfolioChart = null;

async function loadChart() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    if (!Array.isArray(history) || history.length === 0) {
      renderEmptyChart();
      return;
    }
    renderChart(history);
  } catch (e) {
    renderEmptyChart();
  }
}

function renderChart(history) {
  const ctx = document.getElementById('portfolio-chart');
  if (!ctx) return;

  // Build data points from market history
  const labels = [];
  const oddsData = [];
  const momentumData = [];

  for (const entry of history.slice(-50)) {
    const time = entry.endTime
      ? new Date(entry.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '?';
    labels.push(time);

    const finalUp = entry.finalOdds?.up;
    oddsData.push(finalUp != null ? +(finalUp * 100).toFixed(1) : null);
    momentumData.push(entry.finalMomentum != null ? +entry.finalMomentum.toFixed(3) : null);
  }

  if (portfolioChart) portfolioChart.destroy();

  portfolioChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Final UP Odds %',
          data: oddsData,
          borderColor: '#00ff41',
          backgroundColor: 'rgba(0, 255, 65, 0.1)',
          borderWidth: 2,
          pointRadius: 4,
          pointStyle: 'rect',
          pointBackgroundColor: '#00ff41',
          stepped: true,
          fill: true,
          tension: 0,
        },
        {
          label: 'Momentum %',
          data: momentumData,
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0, 212, 255, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          pointStyle: 'rect',
          pointBackgroundColor: '#00d4ff',
          stepped: false,
          fill: false,
          tension: 0,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: '#666680',
            font: { family: 'VT323', size: 14 },
          },
        },
        tooltip: {
          backgroundColor: '#1a1a2e',
          borderColor: '#3a3a5c',
          borderWidth: 2,
          titleFont: { family: 'VT323', size: 16 },
          bodyFont: { family: 'VT323', size: 14 },
          titleColor: '#ffd700',
          bodyColor: '#e0e0e0',
        },
      },
      scales: {
        x: {
          grid: { color: '#2a2a44' },
          ticks: {
            color: '#666680',
            font: { family: 'VT323', size: 12 },
            maxRotation: 45,
          },
        },
        y: {
          position: 'left',
          grid: { color: '#2a2a44' },
          ticks: {
            color: '#00ff41',
            font: { family: 'VT323', size: 14 },
            callback: (v) => v + '%',
          },
          min: 0,
          max: 100,
        },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: {
            color: '#00d4ff',
            font: { family: 'VT323', size: 14 },
            callback: (v) => v + '%',
          },
        },
      },
    },
  });
}

function renderEmptyChart() {
  const ctx = document.getElementById('portfolio-chart');
  if (!ctx) return;

  if (portfolioChart) portfolioChart.destroy();

  portfolioChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['No data yet'],
      datasets: [{
        label: 'Final UP Odds %',
        data: [null],
        borderColor: '#00ff41',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#666680',
            font: { family: 'VT323', size: 14 },
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#2a2a44' },
          ticks: { color: '#666680', font: { family: 'VT323', size: 12 } },
        },
        y: {
          grid: { color: '#2a2a44' },
          ticks: { color: '#666680', font: { family: 'VT323', size: 14 } },
          min: 0,
          max: 100,
        },
      },
    },
  });
}
