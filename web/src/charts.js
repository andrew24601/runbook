import Chart from "chart.js/auto";
import { JSONPath } from "jsonpath-plus";

import { buildTemplateContext } from "./templates.js";

const SUPPORTED_CHART_TYPES = new Set(["line", "bar", "scatter"]);

export function buildChartNodeState(node, state) {
  const spec = node.chart || {};
  const type = String(spec.type || "").trim().toLowerCase();
  const xPath = String(spec.x || "").trim();
  const yPath = String(spec.y || "").trim();
  const label = String(spec.label || "").trim();

  if (!type) {
    return buildChartError("Chart type is required.");
  }

  if (!SUPPORTED_CHART_TYPES.has(type)) {
    return buildChartError(`Unsupported chart type: ${type}. Use line, bar, or scatter.`);
  }

  if (!xPath) {
    return buildChartError("Chart x path is required.");
  }

  if (!yPath) {
    return buildChartError("Chart y path is required.");
  }

  const root = buildWorkbookOutputRoot(state.parsedDocument.nodes, state.runtimeState);
  const xResult = resolveChartPath(xPath, root, "x");
  if (xResult.error) {
    return buildChartError(xResult.error);
  }

  const yResult = resolveChartPath(yPath, root, "y");
  if (yResult.error) {
    return buildChartError(yResult.error);
  }

  const xValues = xResult.values;
  const yValues = yResult.values;
  if (!xValues.length) {
    return buildChartError(`No values matched x path: ${xPath}`);
  }

  if (!yValues.length) {
    return buildChartError(`No values matched y path: ${yPath}`);
  }

  if (xValues.length !== yValues.length) {
    return buildChartError(`Chart x/y length mismatch: ${xValues.length} x values and ${yValues.length} y values.`);
  }

  const numericYValues = yValues.map((value) => Number(value));
  const badYIndex = numericYValues.findIndex((value) => !Number.isFinite(value));
  if (badYIndex !== -1) {
    return buildChartError(`Chart y value at index ${badYIndex} is not numeric.`);
  }

  if (type === "scatter") {
    const numericXValues = xValues.map((value) => Number(value));
    const badXIndex = numericXValues.findIndex((value) => !Number.isFinite(value));
    if (badXIndex !== -1) {
      return buildChartError(`Scatter chart x value at index ${badXIndex} is not numeric.`);
    }

    return {
      status: "success",
      type,
      label: label || "Series",
      data: {
        datasets: [{
          label: label || "Series",
          data: numericXValues.map((x, index) => ({ x, y: numericYValues[index] })),
          borderColor: "#28528b",
          backgroundColor: "rgba(40, 82, 139, 0.16)",
          pointRadius: 3
        }]
      }
    };
  }

  return {
    status: "success",
    type,
    label: label || "Series",
    data: {
      labels: xValues.map((value) => value == null ? "" : String(value)),
      datasets: [{
        label: label || "Series",
        data: numericYValues,
        borderColor: "#28528b",
        backgroundColor: type === "bar" ? "rgba(40, 82, 139, 0.22)" : "rgba(40, 82, 139, 0.12)",
        borderWidth: 2,
        tension: type === "line" ? 0.28 : 0,
        pointRadius: type === "line" ? 2 : 0
      }]
    }
  };
}

export function renderChartCell(node, chartState) {
  const wrap = document.createElement("div");
  wrap.className = "chart-cell";

  if (!chartState || chartState.status === "failure") {
    const error = document.createElement("div");
    error.className = "chart-error";
    error.textContent = chartState && chartState.error ? chartState.error : "Chart could not be rendered.";
    wrap.appendChild(error);
    return wrap;
  }

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "chart-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${chartState.label} ${chartState.type} chart`);
  canvasWrap.appendChild(canvas);
  wrap.appendChild(canvasWrap);

  requestAnimationFrame(() => {
    if (!canvas.isConnected) {
      return;
    }

    try {
      destroyChartForCanvas(canvas);
      new Chart(canvas, {
        type: chartState.type,
        data: chartState.data,
        options: buildChartOptions(chartState.type)
      });
    } catch (error) {
      console.error("RunDown chart render failed", error);
      if (canvasWrap.isConnected) {
        canvasWrap.replaceWith(renderChartError(error));
      }
    }
  });

  return wrap;
}

export function destroyChartsInElement(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return;
  }

  root.querySelectorAll("canvas").forEach((canvas) => {
    destroyChartForCanvas(canvas);
  });
}

function buildWorkbookOutputRoot(nodes, runtimeState) {
  const context = buildTemplateContext(nodes || [], runtimeState || {});
  const root = {};

  Object.entries(context.variablesByNamespace || {}).forEach(([name, value]) => {
    root[name] = value;
  });

  Object.entries(context.httpEntriesByCell || {}).forEach(([name, value]) => {
    if (!Object.prototype.hasOwnProperty.call(root, name)) {
      root[name] = value;
    }
  });

  Object.entries(context.javascriptEntriesByCell || {}).forEach(([name, value]) => {
    if (!Object.prototype.hasOwnProperty.call(root, name)) {
      root[name] = value;
    }
  });

  return root;
}

function resolveChartPath(path, root, axisName) {
  try {
    return {
      values: JSONPath({
        path,
        json: root,
        wrap: true,
        eval: false
      }),
      error: ""
    };
  } catch (error) {
    return {
      values: [],
      error: `Invalid ${axisName} JSONPath: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function buildChartError(error) {
  return {
    status: "failure",
    error
  };
}

function renderChartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const wrap = document.createElement("div");
  wrap.className = "chart-error";
  wrap.textContent = message || "Chart could not be rendered.";
  return wrap;
}

function buildChartOptions(type) {
  return {
    animation: false,
    maintainAspectRatio: false,
    responsive: true,
    plugins: {
      legend: {
        display: true,
        labels: {
          boxWidth: 12,
          color: "#1d2522",
          font: {
            family: "\"Avenir Next\", \"Gill Sans\", sans-serif"
          }
        }
      },
      tooltip: {
        intersect: false,
        mode: type === "scatter" ? "nearest" : "index"
      }
    },
    scales: {
      x: {
        grid: {
          color: "rgba(29, 37, 34, 0.08)"
        },
        ticks: {
          color: "#5f665d"
        }
      },
      y: {
        grid: {
          color: "rgba(29, 37, 34, 0.08)"
        },
        ticks: {
          color: "#5f665d"
        }
      }
    }
  };
}

function destroyChartForCanvas(canvas) {
  const chart = Chart.getChart(canvas);
  if (chart) {
    chart.destroy();
  }
}
