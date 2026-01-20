import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";
import { Copy, Printer, FileText, Settings, Database, Play, AlertTriangle, CheckCircle, RefreshCw, Upload, Save, ChevronRight, Calculator, User, FileUp, Shield, Clock, TrendingUp, Layers, Calendar } from 'lucide-react';

// --- Types ---

interface EstimateItem {
  id: string;
  name: string;       // Equipment name
  model: string;      // Specific model (e.g. S2000-M)
  qty: number;
  unit: string;
  equipPrice: number; // Unit price equipment
  workName: string;   // Linked installation work
  workPrice: number;  // Unit price work
  category: 'equipment' | 'material' | 'cable';
}

interface ProjectSettings {
  customerRequisites: string;
  contractorRequisites: string;
  coefPnr: number; // %
  coefVat: number; // %
  coefUnexpected: number; // %
  projectNumber: string;
  projectDate: string;
  workStartDate: string;
  workDuration: number; // Days
}

interface ValidationIssue {
  type: 'error' | 'warning' | 'success';
  message: string;
  suggestion?: string;
}

interface FileData {
    name: string;
    mimeType: string;
    data: string; // base64
}

// --- Default Data ---

const DEFAULT_PRICING_BASE = `
Монтаж извещателя пожарного дымового (ДИП) - 450 руб
Монтаж извещателя пожарного ручного (ИПР) - 350 руб
Монтаж прибора приемно-контрольного (до 20 шлейфов) - 2500 руб
Монтаж пульта управления (С2000М и аналоги) - 1800 руб
Монтаж блока питания (РИП) - 1200 руб
Монтаж оповещателя свето-звукового (Табло, Сирена) - 650 руб
Прокладка кабеля (гофра/лоткок) - 65 руб/м
Монтаж модуля релейного (С2000-СП1 и т.п.) - 1100 руб
Коммутация разветвительной коробки - 250 руб
`;

const INITIAL_SETTINGS: ProjectSettings = {
  customerRequisites: `ФГБУ "ЦНИИ ВКО" Минобороны России\nИНН 1234567890\nАдрес: г. Тверь, ул. Жигарева, 50`,
  contractorRequisites: `ООО "СпецПожМонтаж"\nИНН 0987654321\nР/с 40702810... Сбербанк\nТел: +7 (999) 000-00-00`,
  coefPnr: 15,
  coefVat: 20,
  coefUnexpected: 2,
  projectNumber: "КП-2023/10-45",
  projectDate: new Date().toLocaleDateString('ru-RU'),
  workStartDate: new Date().toISOString().split('T')[0],
  workDuration: 45
};

// --- Helpers ---

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
        const result = reader.result as string;
        // remove data:image/png;base64, prefix
        const base64 = result.split(',')[1];
        resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};

const formatDate = (date: Date): string => {
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// --- Main App Component ---

const App = () => {
  // Steps: settings -> database -> import -> estimate -> preview
  const [step, setStep] = useState<'settings' | 'database' | 'import' | 'estimate' | 'preview'>('settings');
  
  // State
  const [settings, setSettings] = useState<ProjectSettings>(INITIAL_SETTINGS);
  const [pricingText, setPricingText] = useState<string>(DEFAULT_PRICING_BASE);
  
  // Files
  const [specInput, setSpecInput] = useState<string>("");
  const [specFile, setSpecFile] = useState<FileData | null>(null);
  const [dbFile, setDbFile] = useState<FileData | null>(null);

  const [items, setItems] = useState<EstimateItem[]>([]);
  const [validationLog, setValidationLog] = useState<ValidationIssue[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>("");

  // AI Client
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // --- Actions ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'spec' | 'db') => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
          const base64 = await fileToBase64(file);
          const fileData = { name: file.name, mimeType: file.type, data: base64 };
          if (type === 'spec') setSpecFile(fileData);
          else setDbFile(fileData);
      } catch (err) {
          alert("Ошибка чтения файла");
      }
  };

  const handleProcessSpec = async () => {
    if (!specInput.trim() && !specFile) {
      alert("Пожалуйста, введите текст спецификации или загрузите файл.");
      return;
    }

    setIsProcessing(true);
    setAgentStatus("Загрузка данных в мультимодальную модель...");
    setStep('estimate'); 

    try {
      // Подготовка контекста и промпта
      const parts: any[] = [];
      
      let pricingContext = `БАЗА РАСЦЕНОК (ТЕКСТ): ${pricingText}`;
      if (dbFile) {
          pricingContext += "\nТАКЖЕ ИСПОЛЬЗУЙ РАСЦЕНКИ ИЗ ПРИЛОЖЕННОГО ФАЙЛА БАЗЫ ДАННЫХ.";
          parts.push({ inlineData: { mimeType: dbFile.mimeType, data: dbFile.data } });
      }

      let specContext = `ВХОДНЫЕ ДАННЫЕ (СПЕЦИФИКАЦИЯ ТЕКСТ): ${specInput}`;
      if (specFile) {
          specContext += "\nОСНОВНОЙ ИСТОЧНИК ДАННЫХ - ПРИЛОЖЕННЫЙ ФАЙЛ СПЕЦИФИКАЦИИ (PDF/КАРТИНКА). ИЗВЛЕКИ ВСЕ ПОЗИЦИИ ИЗ ТАБЛИЦ.";
          parts.push({ inlineData: { mimeType: specFile.mimeType, data: specFile.data } });
      }

      const prompt = `
        Ты — инженер-сметчик систем безопасности. Твоя задача — преобразовать данные спецификации в структурированные данные для КП.
        
        ${specContext}

        ${pricingContext}

        ИНСТРУКЦИЯ:
        1. Найди все позиции оборудования и материалов.
        2. Определи модель.
        3. Определи количество (qty).
        4. Примерно оцени рыночную стоимость оборудования (equipPrice) в рублях (цены 2024-2025).
        5. Подбери работу (workName) из Базы Расценок.
        6. Укажи цену работы (workPrice).
        7. Категория: 'equipment', 'material', 'cable'.

        Верни ТОЛЬКО JSON массив.
      `;

      parts.push({ text: prompt });

      setAgentStatus("Анализ документа и подбор расценок...");
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp', // Используем 2.0 Flash для надежной мультимодальности
        contents: { parts },
        config: {
            responseMimeType: 'application/json' // Принудительный JSON
        }
      });

      let responseText = response.text;
      
      if (!responseText) {
          throw new Error("Пустой ответ от модели");
      }

      console.log("Raw Response:", responseText);

      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        const parsedItems = JSON.parse(jsonMatch[0]).map((item: any) => ({
          ...item,
          id: Math.random().toString(36).substr(2, 9)
        }));
        setItems(parsedItems);
        setAgentStatus("Готово!");
      } else {
        throw new Error("Не удалось распознать JSON от AI.");
      }

    } catch (e) {
      console.error(e);
      alert("Ошибка обработки: " + e.message);
    } finally {
      setIsProcessing(false);
      setAgentStatus("");
    }
  };

  const handleValidate = async () => {
    setIsProcessing(true);
    setAgentStatus("Агент проверяет техническое решение...");
    setValidationLog([]);

    try {
      const prompt = `
        Ты — строгий технический надзор. Проверь эту смету.
        ДАННЫЕ СМЕТЫ (JSON): ${JSON.stringify(items)}
        
        Верни JSON массив: [{ "type": "error"|"warning"|"success", "message": "...", "suggestion": "..." }]
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash-exp',
        contents: { parts: [{ text: prompt }] },
        config: { responseMimeType: 'application/json' }
      });

      const text = response.text;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        setValidationLog(JSON.parse(jsonMatch[0]));
      }

    } catch (e) {
      alert("Ошибка валидации: " + e.message);
    } finally {
      setIsProcessing(false);
      setAgentStatus("");
    }
  };

  // --- Calculations ---

  const calculateTotals = () => {
    let totalEquip = 0;
    let totalWork = 0;

    items.forEach(item => {
      totalEquip += item.equipPrice * item.qty;
      totalWork += item.workPrice * item.qty;
    });

    const pnr = totalWork * (settings.coefPnr / 100);
    const subtotal = totalEquip + totalWork + pnr;
    const unexpected = subtotal * (settings.coefUnexpected / 100);
    const vat = (subtotal + unexpected) * (settings.coefVat / 100);
    const grandTotal = subtotal + unexpected + vat;

    return { totalEquip, totalWork, pnr, unexpected, vat, grandTotal, subtotal };
  };

  const totals = calculateTotals();
  
  const optimalTotals = {
      ...totals,
      grandTotal: totals.grandTotal * 1.12 
  };

  // --- Schedule Calculation ---
  const calculateSchedule = () => {
      const start = new Date(settings.workStartDate);
      const totalDays = settings.workDuration;
      
      // Distribution of work
      const d1 = Math.max(2, Math.floor(totalDays * 0.1)); // Design
      const d2 = Math.max(3, Math.floor(totalDays * 0.3)); // Supply
      const d3 = Math.max(5, Math.floor(totalDays * 0.4)); // Install
      const d4 = Math.max(2, Math.floor(totalDays * 0.1)); // PNR
      // Remainder to Handover
      const d5 = Math.max(1, totalDays - d1 - d2 - d3 - d4);

      const s1 = new Date(start);
      const s2 = new Date(start); s2.setDate(s2.getDate() + d1);
      const s3 = new Date(s2); s3.setDate(s3.getDate() + d2);
      const s4 = new Date(s3); s4.setDate(s4.getDate() + d3);
      const s5 = new Date(s4); s5.setDate(s5.getDate() + d4);
      const end = new Date(s5); end.setDate(end.getDate() + d5);

      return [
          { title: 'Проектирование', desc: 'Анализ', start: s1, end: s2, days: d1 },
          { title: 'Поставка', desc: 'Комплектация', start: s2, end: s3, days: d2 },
          { title: 'Монтаж', desc: 'СМР', start: s3, end: s4, days: d3 },
          { title: 'ПНР', desc: 'Наладка', start: s4, end: s5, days: d4 },
          { title: 'Сдача', desc: 'Исполнительная', start: s5, end: end, days: d5 }
      ];
  };

  const schedule = calculateSchedule();

  // --- Render Helpers ---

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(val);
  };

  // --- Step Components ---

  const renderSidebar = () => (
    <div className="w-64 bg-white text-slate-900 flex flex-col h-screen fixed left-0 top-0 no-print z-10 shadow-lg border-r border-slate-200">
      <div className="p-6 border-b border-slate-200">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <Calculator className="text-orange-600" />
          ГОЗ.Смета
        </h1>
        <p className="text-xs text-slate-500 mt-1">AI Генератор КП v2.3</p>
      </div>
      
      <nav className="flex-1 py-4">
        {[
          { id: 'settings', label: 'Реквизиты и Сроки', icon: Settings },
          { id: 'database', label: 'База Расценок', icon: Database },
          { id: 'import', label: 'Спецификация', icon: Upload },
          { id: 'estimate', label: 'Расчет работ', icon: FileText },
          { id: 'preview', label: 'Печать КП', icon: Printer },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setStep(item.id as any)}
            className={`w-full text-left px-6 py-3 flex items-center gap-3 transition-colors ${step === item.id ? 'bg-orange-50 text-orange-700 border-r-4 border-orange-500 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <item.icon size={18} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="p-6 border-t border-slate-200 text-xs text-slate-500">
         Поддержка: PDF, Excel, JPG
         <br/>
         Engine: Google Gemini 2.0
      </div>
    </div>
  );

  const renderContent = () => {
    switch (step) {
      case 'settings':
        return (
          <div className="max-w-4xl mx-auto bg-white p-8 rounded-lg shadow-sm border border-slate-200 text-black">
            <h2 className="text-2xl font-bold mb-6 text-black border-b border-slate-200 pb-2">Настройки Проекта</h2>
            <div className="grid grid-cols-2 gap-8">
              <div className="col-span-2">
                <div className="grid grid-cols-4 gap-4 mb-4">
                    <div className="col-span-1">
                        <label className="block text-sm font-bold text-black mb-1">Номер проекта</label>
                        <input 
                            value={settings.projectNumber}
                            onChange={(e) => setSettings({...settings, projectNumber: e.target.value})}
                            className="w-full p-2 border border-slate-300 rounded bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                        />
                    </div>
                    <div className="col-span-1">
                        <label className="block text-sm font-bold text-black mb-1">Дата КП</label>
                        <input 
                            value={settings.projectDate}
                            onChange={(e) => setSettings({...settings, projectDate: e.target.value})}
                            className="w-full p-2 border border-slate-300 rounded bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                        />
                    </div>
                    <div className="col-span-1">
                        <label className="block text-sm font-bold text-black mb-1">Начало работ</label>
                        <input 
                            type="date"
                            value={settings.workStartDate}
                            onChange={(e) => setSettings({...settings, workStartDate: e.target.value})}
                            className="w-full p-2 border border-slate-300 rounded bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                        />
                    </div>
                    <div className="col-span-1">
                        <label className="block text-sm font-bold text-black mb-1">Срок (дней)</label>
                        <input 
                            type="number"
                            value={settings.workDuration}
                            onChange={(e) => setSettings({...settings, workDuration: parseInt(e.target.value) || 30})}
                            className="w-full p-2 border border-slate-300 rounded bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                        />
                    </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-black mb-1">Заказчик (Реквизиты)</label>
                <textarea 
                  value={settings.customerRequisites}
                  onChange={(e) => setSettings({...settings, customerRequisites: e.target.value})}
                  className="w-full h-40 p-3 border border-slate-300 rounded-lg text-sm font-mono bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-black mb-1">Исполнитель (Реквизиты)</label>
                <textarea 
                  value={settings.contractorRequisites}
                  onChange={(e) => setSettings({...settings, contractorRequisites: e.target.value})}
                  className="w-full h-40 p-3 border border-slate-300 rounded-lg text-sm font-mono bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none resize-none"
                />
              </div>

              <div className="col-span-2 grid grid-cols-3 gap-4 mt-4">
                <div>
                   <label className="block text-sm font-bold text-black mb-1">НДС (%)</label>
                   <input type="number" value={settings.coefVat} onChange={(e) => setSettings({...settings, coefVat: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-300 rounded bg-white text-black" />
                </div>
                <div>
                   <label className="block text-sm font-bold text-black mb-1">Пусконаладка (% от ФОТ)</label>
                   <input type="number" value={settings.coefPnr} onChange={(e) => setSettings({...settings, coefPnr: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-300 rounded bg-white text-black" />
                </div>
                <div>
                   <label className="block text-sm font-bold text-black mb-1">Непредвиденные (%)</label>
                   <input type="number" value={settings.coefUnexpected} onChange={(e) => setSettings({...settings, coefUnexpected: parseFloat(e.target.value)})} className="w-full p-2 border border-slate-300 rounded bg-white text-black" />
                </div>
              </div>
            </div>
            <div className="mt-8 flex justify-end">
               <button onClick={() => setStep('database')} className="bg-orange-600 text-white px-6 py-2 rounded hover:bg-orange-700 flex items-center gap-2">
                 Далее <ChevronRight size={16}/>
               </button>
            </div>
          </div>
        );

      case 'database':
        return (
          <div className="max-w-4xl mx-auto bg-white p-8 rounded-lg shadow-sm border border-slate-200">
             <h2 className="text-2xl font-bold mb-2 text-black">База Расценок</h2>
             <p className="text-slate-600 mb-6 text-sm">Загрузите Excel/PDF с вашими ценами или вставьте текст.</p>
             
             <div className="grid grid-cols-2 gap-6">
                 <div className="relative">
                    <label className="block text-sm font-bold text-black mb-2">Текстовый ввод</label>
                    <textarea 
                      value={pricingText}
                      onChange={(e) => setPricingText(e.target.value)}
                      className="w-full h-96 p-4 border border-slate-300 rounded-lg font-mono text-sm bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                      placeholder="Вставьте список работ и цен..."
                    />
                 </div>
                 
                 <div className="flex flex-col">
                    <label className="block text-sm font-bold text-black mb-2">Файловый ввод (Excel, PDF)</label>
                    <div className="flex-1 border-2 border-dashed border-slate-300 rounded-lg flex flex-col items-center justify-center bg-slate-50 hover:bg-slate-100 transition-colors relative">
                        <input 
                            type="file" 
                            accept=".xlsx,.xls,.pdf,.jpg,.png"
                            onChange={(e) => handleFileUpload(e, 'db')}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                        <Upload className="text-slate-400 mb-2" size={48} />
                        <p className="text-sm text-slate-500">Перетащите файл прайса сюда</p>
                        {dbFile && (
                            <div className="mt-4 flex items-center gap-2 text-green-700 bg-green-50 px-3 py-1 rounded-full text-sm font-medium border border-green-200">
                                <CheckCircle size={14}/> {dbFile.name}
                            </div>
                        )}
                    </div>
                 </div>
             </div>

             <div className="mt-8 flex justify-end gap-3">
               <button onClick={() => setStep('settings')} className="text-slate-600 hover:text-black px-4">Назад</button>
               <button onClick={() => setStep('import')} className="bg-orange-600 text-white px-6 py-2 rounded hover:bg-orange-700 flex items-center gap-2">
                 Далее <ChevronRight size={16}/>
               </button>
            </div>
          </div>
        );

      case 'import':
        return (
          <div className="max-w-4xl mx-auto bg-white p-8 rounded-lg shadow-sm border border-slate-200">
             <h2 className="text-2xl font-bold mb-2 text-black">Импорт Спецификации</h2>
             <p className="text-slate-600 mb-6 text-sm">Загрузите PDF проекта или скан спецификации.</p>
             
             <div className="border-2 border-dashed border-indigo-200 bg-indigo-50/20 rounded-xl p-12 text-center mb-6 relative">
                 <input 
                    type="file" 
                    accept=".pdf,.jpg,.png,.jpeg"
                    onChange={(e) => handleFileUpload(e, 'spec')}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                 />
                 <div className="flex justify-center mb-4">
                     <FileUp className="text-indigo-600" size={64} />
                 </div>
                 <h3 className="text-lg font-bold text-indigo-900">Загрузить файл спецификации</h3>
                 <p className="text-indigo-700 text-sm mt-1">Поддерживаются PDF и Изображения</p>
                 {specFile && (
                    <div className="mt-4 inline-flex items-center gap-2 text-green-700 bg-white shadow-sm px-4 py-2 rounded-lg font-medium border border-green-200">
                        <CheckCircle size={16}/> {specFile.name} загружен
                    </div>
                 )}
             </div>

             <div className="mb-6">
                 <div className="flex items-center gap-2 mb-2">
                     <span className="h-px bg-slate-200 flex-1"></span>
                     <span className="text-slate-500 text-xs uppercase font-bold">Или вставьте текст</span>
                     <span className="h-px bg-slate-200 flex-1"></span>
                 </div>
                 <textarea 
                    value={specInput}
                    onChange={(e) => setSpecInput(e.target.value)}
                    className="w-full h-32 p-4 border border-slate-300 rounded-lg font-mono text-sm bg-white text-black focus:ring-2 focus:ring-orange-500 outline-none"
                    placeholder="Ручной ввод позиций..."
                 />
             </div>

             <div className="mt-8 flex justify-end gap-3">
               <button onClick={() => setStep('database')} className="text-slate-600 hover:text-black px-4">Назад</button>
               <button onClick={handleProcessSpec} className="bg-orange-600 text-white px-8 py-3 rounded hover:bg-orange-700 font-medium shadow-lg hover:shadow-xl transition-all flex items-center gap-2">
                 Рассчитать <Play size={16}/>
               </button>
            </div>
          </div>
        );

      case 'estimate':
        return (
          <div className="max-w-6xl mx-auto space-y-6 text-black">
            
            {/* AI Processing Overlay */}
            {isProcessing && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm">
                    <div className="bg-white p-8 rounded-xl shadow-2xl flex flex-col items-center max-w-md text-center">
                        <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <h3 className="text-xl font-bold text-black">AI Агент работает</h3>
                        <p className="text-slate-600 mt-2 animate-pulse">{agentStatus}</p>
                    </div>
                </div>
            )}

            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-2xl font-bold text-black">Расчет КП</h2>
                    <p className="text-sm text-slate-600">Проверьте распознанные данные и назначенные работы.</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={handleValidate} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 flex items-center gap-2 text-sm shadow">
                        <CheckCircle size={16}/> Проверить через AI
                    </button>
                    <button onClick={() => setStep('preview')} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2 text-sm shadow">
                        <Printer size={16}/> К печати
                    </button>
                </div>
            </div>

            {/* Validation Log */}
            {validationLog.length > 0 && (
                <div className="bg-white p-4 rounded-lg shadow-sm border border-indigo-200">
                    <h3 className="font-bold text-indigo-900 mb-3 flex items-center gap-2"><User size={18}/> Отчет Агента-Валидатора</h3>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                        {validationLog.map((log, idx) => (
                            <div key={idx} className={`text-sm p-2 rounded flex gap-2 ${log.type === 'error' ? 'bg-red-50 text-red-900' : log.type === 'warning' ? 'bg-yellow-50 text-yellow-900' : 'bg-green-50 text-green-900'}`}>
                                {log.type === 'error' ? <AlertTriangle size={16} className="shrink-0 mt-0.5"/> : <CheckCircle size={16} className="shrink-0 mt-0.5"/>}
                                <div>
                                    <span className="font-bold block">{log.message}</span>
                                    {log.suggestion && <span className="opacity-90 text-xs">Совет: {log.suggestion}</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Main Table */}
            <div className="bg-white rounded-lg shadow-sm overflow-hidden border border-slate-300">
                <table className="w-full text-sm text-left text-black">
                    <thead className="bg-slate-100 text-slate-900 uppercase text-xs font-bold border-b border-slate-300">
                        <tr>
                            <th className="p-3 w-10">№</th>
                            <th className="p-3 w-1/3">Наименование оборудования</th>
                            <th className="p-3 text-right">Кол-во</th>
                            <th className="p-3 text-right">Цена мат.</th>
                            <th className="p-3 w-1/3 text-indigo-900 bg-indigo-50/50">Сопутствующая работа (AI)</th>
                            <th className="p-3 text-right bg-indigo-50/50">Цена раб.</th>
                            <th className="p-3 text-right">Сумма</th>
                            <th className="p-3 text-center">Действия</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                        {items.length === 0 ? (
                            <tr><td colSpan={8} className="p-8 text-center text-slate-500">Нет данных. Вернитесь на шаг импорта.</td></tr>
                        ) : items.map((item, idx) => (
                            <tr key={item.id} className="hover:bg-slate-50 group text-black">
                                <td className="p-3 text-slate-500">{idx + 1}</td>
                                <td className="p-3">
                                    <input 
                                        className="w-full bg-transparent font-bold text-black outline-none border-b border-transparent focus:border-orange-500" 
                                        value={item.model || item.name}
                                        onChange={(e) => {
                                            const newItems = [...items];
                                            newItems[idx].model = e.target.value;
                                            setItems(newItems);
                                        }}
                                    />
                                    <div className="text-xs text-slate-500">{item.category}</div>
                                </td>
                                <td className="p-3 text-right">
                                    <input 
                                        type="number"
                                        className="w-16 text-right bg-transparent outline-none border-b border-transparent focus:border-orange-500 font-medium"
                                        value={item.qty}
                                        onChange={(e) => {
                                            const newItems = [...items];
                                            newItems[idx].qty = parseFloat(e.target.value) || 0;
                                            setItems(newItems);
                                        }}
                                    /> <span className="text-slate-500 text-xs">{item.unit}</span>
                                </td>
                                <td className="p-3 text-right">
                                     <input 
                                        type="number"
                                        className="w-20 text-right bg-transparent outline-none border-b border-transparent focus:border-orange-500 font-medium"
                                        value={item.equipPrice}
                                        onChange={(e) => {
                                            const newItems = [...items];
                                            newItems[idx].equipPrice = parseFloat(e.target.value) || 0;
                                            setItems(newItems);
                                        }}
                                    />
                                </td>
                                <td className="p-3 bg-indigo-50/20">
                                     <input 
                                        className="w-full bg-transparent text-indigo-900 font-medium outline-none border-b border-transparent focus:border-indigo-500"
                                        value={item.workName}
                                        onChange={(e) => {
                                            const newItems = [...items];
                                            newItems[idx].workName = e.target.value;
                                            setItems(newItems);
                                        }}
                                    />
                                </td>
                                <td className="p-3 text-right bg-indigo-50/20">
                                     <input 
                                        type="number"
                                        className="w-20 text-right bg-transparent outline-none border-b border-transparent focus:border-indigo-500 font-medium"
                                        value={item.workPrice}
                                        onChange={(e) => {
                                            const newItems = [...items];
                                            newItems[idx].workPrice = parseFloat(e.target.value) || 0;
                                            setItems(newItems);
                                        }}
                                    />
                                </td>
                                <td className="p-3 text-right font-bold text-black">
                                    {formatCurrency((item.equipPrice + item.workPrice) * item.qty)}
                                </td>
                                <td className="p-3 text-center">
                                    <button 
                                        onClick={() => setItems(items.filter(i => i.id !== item.id))}
                                        className="text-slate-400 hover:text-red-600 transition-colors"
                                    >
                                        &times;
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot className="bg-slate-50 font-bold text-black border-t border-slate-300">
                        <tr>
                            <td colSpan={6} className="p-3 text-right">Итого Оборудование + Работа:</td>
                            <td className="p-3 text-right">{formatCurrency(totals.totalEquip + totals.totalWork)}</td>
                            <td></td>
                        </tr>
                        <tr>
                            <td colSpan={6} className="p-3 text-right text-xs uppercase text-slate-600">Пусконаладка ({settings.coefPnr}% от работ):</td>
                            <td className="p-3 text-right text-sm">{formatCurrency(totals.pnr)}</td>
                            <td></td>
                        </tr>
                         <tr>
                            <td colSpan={6} className="p-3 text-right text-xs uppercase text-slate-600">Непредвиденные ({settings.coefUnexpected}%):</td>
                            <td className="p-3 text-right text-sm">{formatCurrency(totals.unexpected)}</td>
                            <td></td>
                        </tr>
                         <tr>
                            <td colSpan={6} className="p-3 text-right text-xs uppercase text-slate-600">НДС ({settings.coefVat}%):</td>
                            <td className="p-3 text-right text-sm">{formatCurrency(totals.vat)}</td>
                            <td></td>
                        </tr>
                         <tr className="bg-slate-100 border-t-2 border-black">
                            <td colSpan={6} className="p-4 text-right text-lg text-black">ВСЕГО ПО КП:</td>
                            <td className="p-4 text-right text-lg text-black">{formatCurrency(totals.grandTotal)}</td>
                            <td></td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
        );

      case 'preview':
        return (
          <div className="max-w-5xl mx-auto">
             <div className="flex justify-between items-center mb-8 no-print">
                <button onClick={() => setStep('estimate')} className="text-slate-800 hover:text-black flex items-center gap-2 font-medium">
                    &larr; Вернуться к редактированию
                </button>
                <button onClick={() => window.print()} className="bg-black text-white px-6 py-3 rounded-lg shadow-lg hover:bg-slate-800 flex items-center gap-2 font-bold">
                    <Printer size={20}/> Печать / Сохранить в PDF
                </button>
             </div>

             {/* Print Canvas - A4 Styles simulated - High Contrast Black on White */}
             <div className="bg-white shadow-2xl p-0 min-h-[29.7cm] text-black serif-print relative print:shadow-none print:w-full">
                
                {/* Formal Header - White Background, Black Text */}
                <div className="bg-white p-12 border-b-2 border-black">
                    <div className="flex justify-between items-start">
                        <div>
                            <div className="text-black font-bold tracking-widest text-sm mb-2 uppercase border-b border-black inline-block pb-1">Коммерческое Предложение</div>
                            <h1 className="text-3xl font-bold mb-4 mt-2 text-black">Монтаж систем <br/>пожарной безопасности</h1>
                            <p className="text-black font-medium">Исх. № {settings.projectNumber} от {settings.projectDate}</p>
                        </div>
                        <div className="text-right">
                             <h2 className="text-xl font-bold text-black mb-2">{settings.contractorRequisites.split('\n')[0]}</h2>
                             <div className="text-sm text-black mt-2 max-w-xs whitespace-pre-wrap leading-tight">{settings.contractorRequisites.split('\n').slice(1).join('\n')}</div>
                        </div>
                    </div>
                </div>

                <div className="p-12">
                    {/* Addressed To */}
                    <div className="mb-12 flex gap-8 border-b border-gray-200 pb-8">
                        <div className="w-1/3 text-black font-bold text-sm uppercase tracking-wide pt-1">Заказчик:</div>
                        <div className="w-2/3 text-lg text-black whitespace-pre-wrap leading-snug">{settings.customerRequisites}</div>
                    </div>

                    {/* Stages of Work - Black & White Style */}
                    <div className="mb-12 break-inside-avoid">
                        <h2 className="text-xl font-bold mb-6 text-black flex items-center gap-2 uppercase border-b border-black pb-2">
                            График реализации работ
                        </h2>
                        <div className="flex justify-between relative mt-8">
                            {/* Horizontal Line */}
                            <div className="absolute top-3 left-0 w-full h-0.5 bg-black -z-10"></div>
                            
                            {schedule.map((s, i) => (
                                <div key={i} className="bg-white px-2 text-center relative group w-1/5">
                                    <div className="w-6 h-6 rounded-full bg-black text-white flex items-center justify-center text-xs font-bold mx-auto mb-2 border-2 border-white z-10 relative">
                                        {i+1}
                                    </div>
                                    <div className="font-bold text-sm text-black uppercase">{s.title}</div>
                                    <div className="text-xs text-black italic mb-1">{s.desc}</div>
                                    <div className="text-[10px] font-mono border border-black py-1 px-1 text-black inline-block mt-1 bg-white">
                                        {formatDate(s.start)} - {formatDate(s.end)}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="mt-6 text-right text-sm font-bold border-t border-gray-300 pt-2">
                            Общий срок: {settings.workDuration} дней
                        </div>
                    </div>

                    {/* Detailed Spec Table - Formal Style */}
                    <div className="mb-12">
                        <h2 className="text-xl font-bold mb-4 text-black uppercase border-b border-black pb-2">1. Спецификация работ и оборудования</h2>
                        <table className="w-full text-xs border-collapse border border-black">
                            <thead>
                                <tr className="bg-gray-100 border-b border-black text-black">
                                    <th className="p-2 text-left font-bold border-r border-black">Наименование</th>
                                    <th className="p-2 text-center font-bold border-r border-black w-10">Ед.</th>
                                    <th className="p-2 text-center font-bold border-r border-black w-12">Кол.</th>
                                    <th className="p-2 text-right font-bold border-r border-black w-24">Цена ед.</th>
                                    <th className="p-2 text-right font-bold w-24">Сумма</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item, idx) => (
                                    <tr key={item.id} className="border-b border-gray-400 text-black">
                                        <td className="p-2 border-r border-gray-400">
                                            <div className="font-bold">{item.model || item.name}</div>
                                            <div className="text-[10px] italic mt-1 pl-2 border-l border-gray-400">Монтаж: {item.workName}</div>
                                        </td>
                                        <td className="p-2 text-center border-r border-gray-400">{item.unit}</td>
                                        <td className="p-2 text-center font-bold border-r border-gray-400">{item.qty}</td>
                                        <td className="p-2 text-right border-r border-gray-400">
                                            <div>{formatCurrency(item.equipPrice)}</div>
                                            <div className="text-[10px] italic">{formatCurrency(item.workPrice)}</div>
                                        </td>
                                        <td className="p-2 text-right font-bold">
                                            <div>{formatCurrency(item.equipPrice * item.qty)}</div>
                                            <div className="text-[10px] font-normal">{formatCurrency(item.workPrice * item.qty)}</div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Commercial Scenarios - Formal Black/White */}
                    <div className="break-inside-avoid">
                        <h2 className="text-xl font-bold mb-6 text-black uppercase border-b border-black pb-2">
                             Стоимость и условия
                        </h2>
                        
                        <div className="grid grid-cols-2 gap-8">
                            {/* Economy Option */}
                            <div className="p-4 border-2 border-gray-300">
                                <h3 className="text-lg font-bold text-black mb-2 uppercase border-b border-gray-300 pb-1">Базовый вариант</h3>
                                <p className="text-xs text-black mb-4 h-8 italic">Минимально необходимое оборудование согласно ТЗ.</p>
                                
                                <div className="text-2xl font-bold text-black mb-1">{formatCurrency(totals.grandTotal)}</div>
                                <div className="text-xs text-black mb-4">в т.ч. НДС {settings.coefVat}%</div>

                                <ul className="space-y-2 text-xs text-black mb-4 list-disc pl-4">
                                    <li>Гарантия 12 месяцев</li>
                                    <li>Стандартная техподдержка</li>
                                    <li>Исполнительная документация</li>
                                </ul>

                                <div className="border-t border-gray-300 pt-2 text-[10px]">
                                    <strong>Оплата:</strong> 70% аванс / 30% расчет
                                </div>
                            </div>

                            {/* Optimal Option */}
                            <div className="p-4 border-2 border-black relative bg-gray-50 print:bg-white">
                                <div className="absolute top-0 right-0 bg-black text-white text-[10px] font-bold px-2 py-1 uppercase">Рекомендуем</div>
                                <h3 className="text-lg font-bold text-black mb-2 uppercase border-b border-black pb-1">Оптимальный вариант</h3>
                                <p className="text-xs text-black mb-4 h-8 italic">Расширенная гарантия и приоритетный сервис.</p>
                                
                                <div className="text-2xl font-bold text-black mb-1">{formatCurrency(optimalTotals.grandTotal)}</div>
                                <div className="text-xs text-black mb-4">в т.ч. НДС {settings.coefVat}%</div>

                                <ul className="space-y-2 text-xs text-black mb-4 list-disc pl-4 font-medium">
                                    <li>Гарантия 36 месяцев</li>
                                    <li>Обучение 2 сотрудников</li>
                                    <li>Техподдержка 24/7</li>
                                </ul>

                                <div className="border-t border-black pt-2 text-[10px]">
                                    <strong>Оплата:</strong> 30% аванс / 70% расчет
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Footer - Signatures */}
                    <div className="mt-16 flex justify-between items-end break-inside-avoid pt-8">
                        <div className="w-5/12">
                             <div className="font-bold text-sm mb-8">Исполнитель:</div>
                             <div className="border-b border-black mb-2"></div>
                             <p className="text-[10px] uppercase">Генеральный директор / М.П.</p>
                        </div>
                         <div className="w-5/12">
                             <div className="font-bold text-sm mb-8">Заказчик:</div>
                             <div className="border-b border-black mb-2"></div>
                             <p className="text-[10px] uppercase">Ответственное лицо / М.П.</p>
                        </div>
                    </div>
                </div>
             </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-screen bg-white">
      {renderSidebar()}
      <div className="flex-1 ml-64 p-8 no-print bg-white">
        {renderContent()}
      </div>
      {/* Print View Wrapper - only visible when printing */}
      <div className="print-only fixed inset-0 bg-white z-[9999]">
         {step === 'preview' && renderContent()}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);