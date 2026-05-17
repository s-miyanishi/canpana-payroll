import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "canpana-payroll-v3";

const SUPABASE_URL = "https://tbvdfgiyqpxpxvyiihrs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_9B6SrI4byxltL-pBDRDvpA_4UGj87RK";
const USE_REMOTE_STORAGE = true;
const NIGHT_RATE = 1.5;

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

const SHIFT_OPTIONS = ["", "○", "×", "△", "休"];
const HOLIDAY_API_URL = "https://holidays-jp.github.io/api/v1/date.json";

function normalizeData(value) {
  return {
    workers: Array.isArray(value?.workers) ? value.workers : [],
    records: Array.isArray(value?.records) ? value.records : [],
    shifts: value?.shifts && typeof value.shifts === "object" ? value.shifts : {},
  };
}

function makeId() {
  return Date.now().toString() + Math.random().toString(36).slice(2);
}

function today() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function toMin(date, time) {
  if (!date || !time) return null;
  const parts = time.split(":");
  const d = new Date(date + "T00:00:00");
  d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
  return Math.floor(d.getTime() / 60000);
}

function minText(value) {
  return Math.floor(value / 60) + "時間" + (value % 60) + "分";
}

function calcPay(record, wage) {
  if (!record.clockIn || !record.clockOut) {
    return { total: 0, night: 0, pay: 0, error: false };
  }

  const start = toMin(record.date, record.clockIn);
  const end = toMin(record.clockOutDate || record.date, record.clockOut);

  if (start === null || end === null || end < start) {
    return { total: 0, night: 0, pay: 0, error: true };
  }

  let normal = 0;
  let night = 0;

  for (let i = start; i < end; i += 1) {
    const hour = new Date(i * 60000).getHours();
    if (hour >= 22 || hour < 5) {
      night += 1;
    } else {
      normal += 1;
    }
  }

  const perMin = Number(wage) / 60;
  const pay = Math.round(normal * perMin + night * perMin * NIGHT_RATE);
  return { total: normal + night, night, pay, error: false };
}

function getCurrentFiscalYear() {
  const d = new Date();
  return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
}

function getCurrentMonthKey() {
  return today().slice(0, 7);
}

function getDaysInMonth(monthKey) {
  const parts = monthKey.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const last = new Date(year, month, 0).getDate();
  const days = [];
  for (let day = 1; day <= last; day += 1) {
    const date = String(year) + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][new Date(date + "T00:00:00").getDay()];
    days.push({ date, label: String(month).padStart(2, "0") + "/" + String(day).padStart(2, "0") + "(" + weekday + ")", weekday });
  }
  return days;
}

async function loadRemoteData() {
  if (!USE_REMOTE_STORAGE) return null;
  const url = SUPABASE_URL + "/rest/v1/app_data?id=eq.canpana&select=data";
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) throw new Error("remote load failed");
  const rows = await response.json();
  if (!rows || rows.length === 0) return { workers: [], records: [], shifts: {} };
  return normalizeData(rows[0].data);
}

async function saveRemoteData(data) {
  if (!USE_REMOTE_STORAGE) return;
  const response = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ id: "canpana", data: normalizeData(data) }),
  });

  if (!response.ok) throw new Error("remote save failed");
}

export default function App() {
  const [data, setData] = useState(function () {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? normalizeData(JSON.parse(saved)) : { workers: [], records: [], shifts: {} };
    } catch (e) {
      return { workers: [], records: [], shifts: {} };
    }
  });

  const [screen, setScreen] = useState("list");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [wage, setWage] = useState("");
  const [transportation, setTransportation] = useState("");
  const [fiscalYear, setFiscalYear] = useState(getCurrentFiscalYear());
  const [shiftMonth, setShiftMonth] = useState(getCurrentMonthKey());
  const [editingWorkerId, setEditingWorkerId] = useState("");
  const [workerEdit, setWorkerEdit] = useState({ name: "", hourlyWage: "", transportation: "" });
  const [editingRecordId, setEditingRecordId] = useState("");
  const [edit, setEdit] = useState({ date: "", clockIn: "", clockOutDate: "", clockOut: "", transportation: 0 });
  const [editError, setEditError] = useState("");
  const [syncStatus, setSyncStatus] = useState(USE_REMOTE_STORAGE ? "共有保存モード" : "端末内保存モード");
  const [remoteLoaded, setRemoteLoaded] = useState(!USE_REMOTE_STORAGE);
  const [holidays, setHolidays] = useState({});

  useEffect(function () {
    if (!USE_REMOTE_STORAGE) return;
    let cancelled = false;
    setSyncStatus("読み込み中...");
    loadRemoteData()
      .then(function (remoteData) {
        if (!cancelled && remoteData) {
          setData(remoteData);
          setRemoteLoaded(true);
          setSyncStatus("共有データ読み込み済み");
        }
      })
      .catch(function () {
        if (!cancelled) {
          setRemoteLoaded(true);
          setSyncStatus("共有データの読み込みに失敗しました");
        }
      });
    return function () {
      cancelled = true;
    };
  }, []);

  useEffect(function () {
    const normalized = normalizeData(data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    if (!USE_REMOTE_STORAGE) return;
    if (!remoteLoaded) return;
    setSyncStatus("保存中...");
    saveRemoteData(normalized)
      .then(function () {
        setSyncStatus("共有保存済み");
      })
      .catch(function () {
        setSyncStatus("共有保存に失敗しました");
      });
  }, [data, remoteLoaded]);

  useEffect(function () {
    fetch(HOLIDAY_API_URL)
      .then(function (response) {
        if (!response.ok) return {};
        return response.json();
      })
      .then(function (holidayData) {
        setHolidays(holidayData || {});
      })
      .catch(function () {
        setHolidays({});
      });
  }, []);

  const selectedWorker = data.workers.find(function (w) {
    return w.id === selectedId;
  });

  const activeRecord = data.records.find(function (r) {
    return r.workerId === selectedId && r.clockIn && !r.clockOut;
  });

  const records = useMemo(function () {
    return data.records
      .filter(function (r) {
        return r.workerId === selectedId;
      })
      .sort(function (a, b) {
        return (b.date + b.clockIn).localeCompare(a.date + a.clockIn);
      });
  }, [data.records, selectedId]);

  const months = useMemo(function () {
    const list = [];
    for (let i = 0; i < 12; i += 1) {
      const monthNumber = ((3 + i) % 12) + 1;
      const displayYear = monthNumber >= 4 ? fiscalYear : fiscalYear + 1;
      list.push({ key: String(displayYear) + "-" + String(monthNumber).padStart(2, "0"), count: 0, total: 0, night: 0, pay: 0 });
    }

    const map = {};
    list.forEach(function (m) {
      map[m.key] = m;
    });

    if (!selectedWorker) return list;

    const startDate = String(fiscalYear) + "-04-01";
    const endDate = String(fiscalYear + 1) + "-04-01";

    data.records.forEach(function (r) {
      if (r.workerId !== selectedId) return;
      if (r.date < startDate || r.date >= endDate) return;
      if (!r.clockIn || !r.clockOut) return;

      const result = calcPay(r, selectedWorker.hourlyWage);
      if (result.error) return;

      const key = r.date.slice(0, 7);
      if (!map[key]) return;

      map[key].count += 1;
      map[key].total += result.total;
      map[key].night += result.night;
      map[key].pay += result.pay + Number(r.transportation || 0);
    });

    return list;
  }, [data.records, selectedId, selectedWorker, fiscalYear]);

  const annualPay = months.reduce(function (sum, m) {
    return sum + m.pay;
  }, 0);

  const annualTime = months.reduce(function (sum, m) {
    return sum + m.total;
  }, 0);

  const currentMonth = today().slice(0, 7);
  const currentMonthData = months.find(function (m) {
    return m.key === currentMonth;
  });
  const currentMonthPay = currentMonthData ? currentMonthData.pay : 0;
  const shiftDays = getDaysInMonth(shiftMonth);

  function goList() {
    setScreen("list");
    setSelectedId("");
    setEditingRecordId("");
    setEditingWorkerId("");
    setEditError("");
  }

  function addWorker() {
    const cleanName = name.trim();
    const cleanWage = Number(wage);
    const cleanTransportation = Number(transportation || 0);
    if (!cleanName || cleanWage <= 0 || cleanTransportation < 0) return;

    const worker = { id: makeId(), name: cleanName, hourlyWage: cleanWage, transportation: cleanTransportation };
    setData(function (prev) {
      return { ...normalizeData(prev), workers: normalizeData(prev).workers.concat(worker) };
    });
    setName("");
    setWage("");
    setTransportation("");
    setSelectedId(worker.id);
    setScreen("attendance");
  }

  function startWorkerEdit(worker) {
    setEditingWorkerId(worker.id);
    setWorkerEdit({ name: worker.name, hourlyWage: worker.hourlyWage, transportation: worker.transportation || 0 });
  }

  function saveWorkerEdit(id) {
    const cleanName = workerEdit.name.trim();
    const cleanWage = Number(workerEdit.hourlyWage);
    const cleanTransportation = Number(workerEdit.transportation || 0);
    if (!cleanName || cleanWage <= 0 || cleanTransportation < 0) return;

    setData(function (prev) {
      const normalized = normalizeData(prev);
      return {
        ...normalized,
        workers: normalized.workers.map(function (w) {
          if (w.id !== id) return w;
          return { ...w, name: cleanName, hourlyWage: cleanWage, transportation: cleanTransportation };
        }),
      };
    });
    setEditingWorkerId("");
  }

  function deleteWorker(id) {
    const worker = data.workers.find(function (w) {
      return w.id === id;
    });
    if (!worker) return;
    if (!window.confirm(worker.name + "さんを削除します。勤怠データも削除されます。")) return;

    setData(function (prev) {
      const normalized = normalizeData(prev);
      return {
        ...normalized,
        workers: normalized.workers.filter(function (w) {
          return w.id !== id;
        }),
        records: normalized.records.filter(function (r) {
          return r.workerId !== id;
        }),
      };
    });
    goList();
  }

  function clockIn() {
    if (!selectedWorker || activeRecord) return;
    const record = {
      id: makeId(),
      workerId: selectedId,
      date: today(),
      clockIn: nowTime(),
      clockOutDate: "",
      clockOut: "",
      transportation: Number(selectedWorker.transportation || 0),
    };
    setData(function (prev) {
      const normalized = normalizeData(prev);
      return { ...normalized, records: normalized.records.concat(record) };
    });
  }

  function clockOut() {
    if (!activeRecord) return;
    setData(function (prev) {
      const normalized = normalizeData(prev);
      return {
        ...normalized,
        records: normalized.records.map(function (r) {
          if (r.id !== activeRecord.id) return r;
          return { ...r, clockOutDate: today(), clockOut: nowTime() };
        }),
      };
    });
  }

  function startEdit(record) {
    setEditingRecordId(record.id);
    setEditError("");
    setEdit({
      date: record.date,
      clockIn: record.clockIn,
      clockOutDate: record.clockOutDate || record.date,
      clockOut: record.clockOut,
      transportation: record.transportation || 0,
    });
  }

  function saveEdit(id) {
    setEditError("");

    if (!edit.date || !edit.clockIn) {
      setEditError("日付と出勤時間を入力してください");
      return;
    }

    const start = toMin(edit.date, edit.clockIn);
    const end = toMin(edit.clockOutDate || edit.date, edit.clockOut);

    if (edit.clockOut && start !== null && end !== null && end < start) {
      setEditError("退勤時間が出勤時間より前に設定されています");
      return;
    }

    setData(function (prev) {
      const normalized = normalizeData(prev);
      return {
        ...normalized,
        records: normalized.records.map(function (r) {
          if (r.id !== id) return r;
          return {
            ...r,
            date: edit.date,
            clockIn: edit.clockIn,
            clockOutDate: edit.clockOutDate,
            clockOut: edit.clockOut,
            transportation: Number(edit.transportation || 0),
          };
        }),
      };
    });
    setEditingRecordId("");
    setEditError("");
  }

  function deleteRecord(id) {
    setData(function (prev) {
      const normalized = normalizeData(prev);
      return {
        ...normalized,
        records: normalized.records.filter(function (r) {
          return r.id !== id;
        }),
      };
    });
  }

  function getShiftValue(type, date, workerId) {
    return data.shifts?.[shiftMonth]?.[type]?.[date]?.[workerId] || "";
  }

  function updateShift(type, date, workerId, value) {
    setData(function (prev) {
      const normalized = normalizeData(prev);
      const monthData = normalized.shifts[shiftMonth] || { hope: {}, fixed: {} };
      const typeData = monthData[type] || {};
      const dateData = typeData[date] || {};

      return {
        ...normalized,
        shifts: {
          ...normalized.shifts,
          [shiftMonth]: {
            ...monthData,
            [type]: {
              ...typeData,
              [date]: {
                ...dateData,
                [workerId]: value,
              },
            },
          },
        },
      };
    });
  }

  function renderShiftTable(type, title) {
    return (
      <div className="rounded-3xl bg-white p-5 shadow">
        <h2 className="mb-4 text-xl font-bold">{title}</h2>
        <div className="w-full overflow-x-auto rounded-2xl border">
          <table
            className="w-full text-left text-sm"
            style={{ minWidth: Math.max(560, 112 + data.workers.length * 140) + "px" }}
          >            <thead>
              <tr className="border-b bg-slate-50 text-slate-500">
                <th className="sticky left-0 z-10 bg-slate-50 px-3 py-3">日付</th>
                {data.workers.map(function (worker) {
                  return (
                    <th
                      key={worker.id}
                      className="w-24 min-w-24 md:w-36 md:min-w-36 px-2 md:px-4 py-3 text-center whitespace-nowrap"
                    >
                      {worker.name}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shiftDays.map(function (day) {
                const holidayName = holidays[day.date] || "";
                const isHoliday = day.weekday === "日" || Boolean(holidayName);
                const isSaturday = day.weekday === "土";

                return (
                  <tr key={day.date} className="border-b">
                    <td className={"sticky left-0 z-10 w-28 min-w-28 md:w-36 md:min-w-36 bg-white px-3 py-2 font-bold whitespace-nowrap " + (isHoliday ? "text-red-500" : isSaturday ? "text-sky-500" : "text-slate-800")}>
                      <div>{day.label}</div>
                      {holidayName && <div className="text-xs font-bold text-red-500">{holidayName}</div>}
                    </td>

                    {data.workers.map(function (worker) {
                      return (
                        <td key={worker.id} className="px-2 py-2 text-center">
                          <select
                            className="w-20 md:w-32 rounded-xl border bg-white px-2 md:px-3 py-2 text-center font-bold text-base" value={getShiftValue(type, day.date, worker.id)}
                            onChange={function (e) {
                              updateShift(type, day.date, worker.id, e.target.value);
                            }}
                          >
                            {SHIFT_OPTIONS.map(function (option) {
                              return (
                                <option key={option || "blank"} value={option}>
                                  {option || "-"}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl bg-white p-6 shadow">
          <h1 className="text-3xl font-black md:text-4xl">Canpana給与計算</h1>
          <p className="mt-3 inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">{syncStatus}</p>
        </header>

        <div className="flex flex-wrap gap-3">
          <button onClick={goList} className={"rounded-2xl px-4 py-3 font-bold shadow " + (screen === "list" ? "bg-sky-700 text-white" : "bg-white text-slate-700")}>一覧・勤怠入力</button>
          <button onClick={function () { setScreen("register"); setEditingRecordId(""); setEditingWorkerId(""); }} className={"rounded-2xl px-4 py-3 font-bold shadow " + (screen === "register" ? "bg-sky-700 text-white" : "bg-white text-slate-700")}>バイト登録</button>
          <button onClick={function () { setScreen("shift"); setEditingRecordId(""); setEditingWorkerId(""); }} className={"rounded-2xl px-4 py-3 font-bold shadow " + (screen === "shift" ? "bg-sky-700 text-white" : "bg-white text-slate-700")}>シフト管理</button>
        </div>

        {screen === "register" && (
          <section className="grid gap-6 lg:grid-cols-[400px_1fr]">
            <div className="rounded-3xl bg-white p-5 shadow">
              <h2 className="mb-4 text-xl font-bold">バイト登録</h2>
              <div className="space-y-3">
                <input className="w-full rounded-2xl border px-4 py-3" placeholder="名前" value={name} onChange={function (e) { setName(e.target.value); }} />
                <input className="w-full rounded-2xl border px-4 py-3" type="number" placeholder="時給" value={wage} onChange={function (e) { setWage(e.target.value); }} />
                <input className="w-full rounded-2xl border px-4 py-3" type="number" min="0" placeholder="1勤務あたりの交通費" value={transportation} onChange={function (e) { setTransportation(e.target.value); }} />
                <button onClick={addWorker} className="w-full rounded-2xl bg-sky-700 px-4 py-3 font-bold text-white">登録する</button>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow">
              <h2 className="mb-4 text-xl font-bold">登録済みバイト一覧</h2>
              {data.workers.length === 0 && <p className="text-slate-500">まだ登録がありません。</p>}
              <div className="grid gap-3 md:grid-cols-2">
                {data.workers.map(function (w) {
                  const isEditingWorker = editingWorkerId === w.id;
                  return (
                    <div key={w.id} className="rounded-2xl border p-4">
                      {isEditingWorker ? (
                        <div className="space-y-3">
                          <input className="w-full rounded-xl border px-3 py-2" placeholder="名前" value={workerEdit.name} onChange={function (e) { setWorkerEdit({ ...workerEdit, name: e.target.value }); }} />
                          <input className="w-full rounded-xl border px-3 py-2" type="number" placeholder="時給" value={workerEdit.hourlyWage} onChange={function (e) { setWorkerEdit({ ...workerEdit, hourlyWage: e.target.value }); }} />
                          <input className="w-full rounded-xl border px-3 py-2" type="number" min="0" placeholder="1勤務あたりの交通費" value={workerEdit.transportation} onChange={function (e) { setWorkerEdit({ ...workerEdit, transportation: e.target.value }); }} />
                          <div className="flex gap-2">
                            <button onClick={function () { saveWorkerEdit(w.id); }} className="rounded-xl bg-sky-700 px-3 py-2 font-bold text-white">保存</button>
                            <button onClick={function () { setEditingWorkerId(""); }} className="rounded-xl bg-slate-100 px-3 py-2 font-bold">取消</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-bold">{w.name}</p>
                            <p className="text-sm text-slate-500">時給 {yen.format(w.hourlyWage)}</p>
                            <p className="text-sm text-slate-500">交通費 {yen.format(w.transportation || 0)} / 勤務</p>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={function () { startWorkerEdit(w); }} className="rounded-xl bg-slate-100 px-3 py-2 font-bold">修正</button>
                            <button onClick={function () { deleteWorker(w.id); }} className="rounded-xl bg-red-50 px-3 py-2 font-bold text-red-600">削除</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {screen === "list" && (
          <section className="rounded-3xl bg-white p-5 shadow">
            <h2 className="mb-2 text-xl font-bold">自分の名前を選択</h2>
            <p className="mb-5 text-sm text-slate-600">一覧から名前をクリックすると勤怠入力画面に進みます。</p>
            {data.workers.length === 0 && <div className="rounded-2xl bg-slate-50 p-5 text-slate-500">まだ登録がありません。「バイト登録」から追加してください。</div>}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {data.workers.map(function (w) {
                return (
                  <button key={w.id} onClick={function () { setSelectedId(w.id); setScreen("attendance"); }} className="rounded-3xl border bg-slate-50 p-5 text-left shadow hover:bg-white">
                    <p className="text-xl font-black">{w.name}</p>
                    <p className="mt-2 text-sm text-slate-500">時給 {yen.format(w.hourlyWage)}</p>
                    <p className="text-sm text-slate-500">交通費 {yen.format(w.transportation || 0)} / 勤務</p>
                    <p className="mt-4 text-sm font-bold">勤怠入力へ →</p>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {screen === "shift" && (
          <section className="space-y-6">
            <div className="rounded-3xl bg-white p-5 shadow">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-bold">シフト管理</h2>
                  <p className="mt-1 text-sm text-slate-500">希望日と確定シフトを全員で入力できます。</p>
                </div>
                <input
                  className="rounded-2xl border px-4 py-2"
                  type="month"
                  value={shiftMonth}
                  onChange={function (e) {
                    setShiftMonth(e.target.value);
                  }}
                />
              </div>
            </div>
            {data.workers.length === 0 ? (
              <div className="rounded-3xl bg-white p-5 text-slate-500 shadow">先にバイト登録をしてください。</div>
            ) : (
              <>
                {renderShiftTable("hope", "勤務希望日")}
                {renderShiftTable("fixed", "シフト表")}
              </>
            )}
          </section>
        )}

        {screen === "attendance" && selectedWorker && (
          <section className="space-y-6">
            <button onClick={goList} className="rounded-2xl bg-white px-4 py-3 font-bold shadow">← 一覧に戻る</button>

            <div className="grid gap-6 md:grid-cols-3">
              <div className="rounded-3xl bg-white p-5 shadow md:col-span-2">
                <h2 className="text-xl font-bold">{selectedWorker.name}さんの出勤・退勤</h2>
                <p className="mt-2 text-sm text-slate-600">時給：{yen.format(selectedWorker.hourlyWage)}</p>
                <p className="mt-1 text-sm text-slate-600">交通費：{yen.format(selectedWorker.transportation || 0)} / 勤務</p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <button onClick={clockIn} disabled={Boolean(activeRecord)} className="rounded-2xl bg-sky-600 px-4 py-4 font-bold text-white disabled:bg-slate-300">出勤する</button>
                  <button onClick={clockOut} disabled={!activeRecord} className="rounded-2xl bg-rose-400 px-4 py-4 font-bold text-white disabled:bg-slate-300">退勤する</button>
                </div>
                {activeRecord && <p className="mt-4 rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">出勤中：{activeRecord.date} {activeRecord.clockIn}〜</p>}
              </div>

              <div className="rounded-3xl bg-white p-5 shadow">
                <h2 className="text-xl font-bold">今月の給与</h2>
                <p className="mt-3 text-3xl font-black">{yen.format(currentMonthPay)}</p>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow">
              <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-bold">年度単位の給与一覧</h2>
                  <p className="mt-1 text-sm text-slate-500">{fiscalYear}年4月〜{fiscalYear + 1}年3月</p>
                </div>
                <select className="rounded-2xl border px-4 py-2" value={fiscalYear} onChange={function (e) { setFiscalYear(Number(e.target.value)); }}>
                  {Array.from({ length: 20 }, function (_, i) { return 2017 + i; }).map(function (y) {
                    return <option key={y} value={y}>{y}年度</option>;
                  })}
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-slate-500">
                      <th className="py-3">月</th>
                      <th className="py-3">勤務回数</th>
                      <th className="py-3">勤務時間</th>
                      <th className="py-3">深夜時間</th>
                      <th className="py-3 text-right">給与</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map(function (m) {
                      return (
                        <tr key={m.key} className="border-b">
                          <td className="py-3 font-bold">{m.key}</td>
                          <td className="py-3">{m.count}回</td>
                          <td className="py-3">{minText(m.total)}</td>
                          <td className="py-3">{minText(m.night)}</td>
                          <td className="py-3 text-right font-bold">{yen.format(m.pay)}</td>
                        </tr>
                      );
                    })}
                    <tr className="bg-slate-50 font-bold">
                      <td className="py-4">1年の総額</td>
                      <td className="py-4">-</td>
                      <td className="py-4">{minText(annualTime)}</td>
                      <td className="py-4">-</td>
                      <td className="py-4 text-right text-lg">{yen.format(annualPay)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow">
              <h2 className="mb-4 text-xl font-bold">勤務履歴・修正</h2>
              {editError && <div className="mb-4 rounded-2xl bg-red-50 p-3 text-sm font-bold text-red-700">{editError}</div>}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-slate-500">
                      <th className="sticky left-0 z-20 w-28 bg-slate-50 px-3 py-3 whitespace-nowrap">
                        日付
                      </th>
                      <th className="py-3">出勤</th>
                      <th className="py-3">退勤日</th>
                      <th className="py-3">退勤</th>
                      <th className="py-3">交通費</th>
                      <th className="py-3">勤務時間</th>
                      <th className="py-3">深夜</th>
                      <th className="py-3 text-right">給与</th>
                      <th className="py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 && <tr><td colSpan="9" className="py-8 text-center text-slate-500">勤務履歴がありません。</td></tr>}
                    {records.map(function (r) {
                      const result = calcPay(r, selectedWorker.hourlyWage);
                      const isEdit = editingRecordId === r.id;
                      return (
                        <tr key={r.id} className="border-b">
                          <td className="py-3">{isEdit ? <input className="rounded border px-2 py-1" type="date" value={edit.date} onChange={function (e) { setEdit({ ...edit, date: e.target.value }); }} /> : r.date}</td>
                          <td className="py-3">{isEdit ? <input className="rounded border px-2 py-1" type="time" value={edit.clockIn} onChange={function (e) { setEdit({ ...edit, clockIn: e.target.value }); }} /> : r.clockIn}</td>
                          <td className="py-3">{isEdit ? <input className="rounded border px-2 py-1" type="date" value={edit.clockOutDate} onChange={function (e) { setEdit({ ...edit, clockOutDate: e.target.value }); }} /> : (r.clockOut ? (r.clockOutDate || r.date) : "未退勤")}</td>
                          <td className="py-3">{isEdit ? <input className="rounded border px-2 py-1" type="time" value={edit.clockOut} onChange={function (e) { setEdit({ ...edit, clockOut: e.target.value }); }} /> : (r.clockOut || "未退勤")}</td>
                          <td className="py-3">{isEdit ? <input className="w-24 rounded border px-2 py-1" type="number" min="0" value={edit.transportation} onChange={function (e) { setEdit({ ...edit, transportation: e.target.value }); }} /> : yen.format(r.transportation || 0)}</td>
                          <td className="py-3">{result.error ? "日時エラー" : minText(result.total)}</td>
                          <td className="py-3">{result.error ? "-" : minText(result.night)}</td>
                          <td className="py-3 text-right font-bold">{result.error ? "-" : yen.format(result.pay + Number(r.transportation || 0))}</td>
                          <td className="py-3 text-right">
                            {isEdit ? (
                              <span className="space-x-2">
                                <button onClick={function () { saveEdit(r.id); }} className="rounded bg-sky-700 px-3 py-2 font-bold text-white">保存</button>
                                <button onClick={function () { setEditingRecordId(""); setEditError(""); }} className="rounded bg-slate-100 px-3 py-2 font-bold">取消</button>
                              </span>
                            ) : (
                              <span className="space-x-2">
                                <button onClick={function () { startEdit(r); }} className="rounded bg-slate-100 px-3 py-2 font-bold">修正</button>
                                <button onClick={function () { deleteRecord(r.id); }} className="rounded bg-red-50 px-3 py-2 font-bold text-red-600">削除</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
