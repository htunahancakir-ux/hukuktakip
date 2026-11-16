const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { parsers } = require('prettier/plugins/babel');
const units = require('../lib/personnel-departments.cjs');
const load = (w, file, names) => {
  const source = fs.readFileSync('outputs/icrapro/' + file, 'utf8');
  for (const node of parsers.babel.parse(source).program.body)
    if (node.type === 'FunctionDeclaration' && names.includes(node.id.name))
      w.eval(source.slice(node.start, node.end));
};
for (const role of ['ceo', 'admin'])
  test(
    role + ': add a unit, handle duplicate errors and select it in a new or existing personnel window',
    async (t) => {
      const dom = new JSDOM('<div id="content"></div>', {
        url: 'http://test.invalid',
        runScripts: 'dangerously',
      });
      t.after(() => dom.window.close());
      const w = dom.window,
        notices = [],
        requests = [];
      const people = [
        {
          id: 'old',
          name: 'Örnek Personel',
          department: 'Temlik',
          officialSalary: 1000,
          unofficialSalary: 200,
          bonus: 50,
          active: true,
        },
      ];
      const state = { data: { 'icrapro-personnel-v1': people } };
      Object.assign(w, {
        $: (q) => w.document.querySelector(q),
        structuredClone,
        hanAuth: { role },
        personnel: people,
        page: 'personnel',
        personnelTab: 'records',
        personnelPayrollTodayMonth: '2026-11',
        bonus2Month: '2026-11',
        dailyBonusMonth: '2026-11',
        businessDate: () => '2026-11-16',
        money: (v) => String(v),
        privateMoney: (v) => v,
        staffMoney: () => ({ salary: 120000, bonus: 5000, total: 125000 }),
        renderActiveOperator() {},
        loadCalculatedBonus2() {},
        requireCeoPin: async () => true,
        toast: (m) => notices.push(m),
        setupExtraContacts() {},
        setupPersonnelPhoneRelationships() {},
        setupPersonnelCompensationTabs() {},
        setupPersonnelDepartmentRole() {},
        setupPersonnelSalaryRequirements() {},
        setupClientCity() {},
        setupClientDistrict() {},
        authApi: (path, method, body) => {
          requests.push({ path, method, body });
          if (path === '/api/users') return [];
          if (path.startsWith('/api/daily-bonuses')) return { rows: [] };
          if (path === '/api/personnel-departments') {
            if (method === 'POST' || method === 'PATCH') {
              const change =
                body.action === 'rename'
                  ? units.rename(state, body.id, body.name, body.previousName)
                  : { name: units.add(state, body.name) };
              return { ...change, departments: units.departments(state), units: units.catalog(state) };
            }
            return { departments: units.departments(state), units: units.catalog(state) };
          }
          throw Error('Unexpected API ' + path);
        },
      });
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
      w.eval(fs.readFileSync('outputs/icrapro/html-safety.js', 'utf8'));
      w.esc = w.escapeHtml;
      load(w, 'form-inputs.js', ['field']);
      load(w, 'client-records.js', ['clientCityField']);
      load(w, 'personnel.js', [
        'personnelSettings',
        'isRealPersonnelRecord',
        'personnelDepartmentCode',
        'personnelDepartmentLabel',
        'cachePersonnelDepartments',
        'readPersonnelDepartments',
        'openPersonnelDepartment',
        'openPersonnelRecord',
        'salaryField',
        'setupPersonnelSalaryRequirements',
        'setupPersonnelDepartmentRole',
      ]);
      await w.personnelSettings();
      const add = w.document.getElementById('newPersonnelDepartment');
      assert(add);
      assert.equal(add.textContent, 'Birim Ekle / Düzenle');
      assert.match(w.document.querySelector('#personnelView tbody').textContent, /Call Center-T/);
      await add.onclick();
      let dialog = w.document.getElementById('personnelDepartmentDialog'),
        form = dialog.querySelector('form');
      assert.equal(dialog.open, true);
      form.elements.departmentName.value = 'Temlik';
      await form.onsubmit({ preventDefault() {} });
      assert.equal(dialog.open, true);
      assert.match(form.querySelector('[role="alert"]').textContent, /zaten mevcut/);
      assert.equal(form.querySelector('[type="submit"]').disabled, false);
      form.elements.departmentName.value = 'Saha & Operasyon';
      await form.onsubmit({ preventDefault() {} });
      assert.equal(dialog.open, false);
      assert.deepEqual(state.personnelDepartments, ['Saha & Operasyon']);
      await w.openPersonnelRecord();
      const employee = w.document.getElementById('personnelForm');
      const options = [...employee.elements.department.options].map((o) => o.value);
      assert(options.includes('Saha & Operasyon'));
      assert(options.includes('Call Center-T'));
      assert(!options.includes('Temlik'));
      assert.equal(employee.querySelectorAll('img').length, 0);
      employee.elements.department.value = 'Saha & Operasyon';
      assert.equal(employee.elements.department.value, 'Saha & Operasyon');
      await w.openPersonnelRecord('old');
      assert.equal(w.document.getElementById('personnelForm').elements.department.value, 'Call Center-T');
      assert.equal(people[0].department, 'Temlik', 'rendering a legacy name does not silently mutate data');
      w.document.getElementById('personnelRecordDialog').close();
      async function renameUnit(id, name) {
        await w.openPersonnelDepartment();
        const current = w.document.getElementById('personnelDepartmentForm');
        current.querySelector('[data-edit-department="' + id + '"]').click();
        assert.equal(
          current.elements.departmentName.value,
          units.catalog(state).find((unit) => unit.id === id).name,
        );
        current.elements.departmentName.value = name;
        await current.onsubmit({ preventDefault() {} });
      }
      await renameUnit('Call Center-T', 'T & Operasyon');
      assert.match(w.document.querySelector('#personnelView tbody').textContent, /T & Operasyon/);
      assert.equal(people[0].department, 'Temlik');
      await renameUnit('Yönetici', 'İdare');
      await renameUnit('Diğer', 'Destek');
      await w.openPersonnelRecord('old');
      const edited = w.document.getElementById('personnelForm');
      assert.equal(edited.elements.department.value, 'Call Center-T');
      assert.equal(edited.elements.department.selectedOptions[0].textContent, 'T & Operasyon');
      edited.elements.department.value = 'Diğer';
      edited.elements.department.dispatchEvent(new w.Event('change'));
      assert.equal(edited.elements.department.selectedOptions[0].textContent, 'Destek');
      assert.equal(edited.elements.officialSalary.required, false);
      edited.elements.department.value = 'Yönetici';
      edited.elements.department.dispatchEvent(new w.Event('change'));
      assert.equal(edited.elements.department.selectedOptions[0].textContent, 'İdare');
      assert.equal(edited.elements.loginUsername.required, true);
      load(w, 'workspace-reports.js', ['reportCell']);
      assert.equal(w.reportCell({ cells: { department: 'Yönetici' } }, ['department', 'Birim']), 'İdare');
      assert(
        requests.some(
          (r) =>
            r.body?.action === 'rename' && r.body.id === 'Yönetici' && r.body.previousName === 'Yönetici',
        ),
      );
      assert(requests.some((r) => r.path === '/api/personnel-departments' && r.method === 'POST'));
    },
  );
