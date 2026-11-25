# GesPro Pulse · Portal de Implementación y Estado de Uso

- **Portal oficial en línea:** https://implementacion.gespro.ai/

Aplicación web interactiva y profesional para dar visibilidad a cada cliente de **GesPro Administrativo** sobre:

1. **Cómo avanza su implementación** (flujo visual de 6 fases, cronograma Gantt de 8 semanas, entregables, responsables Cliente vs GesPro y bloqueos).
2. **Si la aplicación se está usando y funcionando de verdad** (semáforo de adopción por módulo del ERP, evolución operativa semanal, usuarios activos, avance en Academia GesPro y salud del servidor).

---

## Cómo abrirla (2 formas)

### Opción 1 · Directo en el navegador (sin servidor)
Abre el archivo `index.html` con doble clic en cualquier navegador moderno (Chrome, Safari, Edge o Firefox). Todo funciona sin internet y los cambios se guardan automáticamente en tu navegador (`localStorage`).

### Opción 2 · Con el servidor local incluido (permite sincronizar en vivo con GesPro)
Desde la carpeta raíz del proyecto:

```bash
node sitio-implementacion/servidor.mjs
```

Luego abre **http://127.0.0.1:4350** (puedes cambiar el puerto con `PORT=4360 node sitio-implementacion/servidor.mjs`).

---

## Qué incluye

- **Dos modos con un clic:**
  - **Vista Cliente:** Limpia y ejecutiva para proyectar en reuniones o compartir por enlace (`?empresa=EMP-001&vista=cliente`).
  - **Modo Consultor:** Permite marcar tareas, cambiar estados, actualizar uso por módulo, registrar bloqueos, agregar notas a la bitácora y dar de alta nuevas empresas con la plantilla oficial de 6 fases.
- **5 vistas interactivas:**
  - **Resumen Ejecutivo:** Doble medidor radial (Avance de Implementación vs Índice de Uso Real), 4 KPIs clave, flujo clicable de 6 fases, gráfica semanal interactiva y foco de alertas.
  - **Flujo de Implementación:** Cronograma visual (Gantt) + checklist filtrable por estado y responsable (`Cliente`, `GesPro`, `Ambos`).
  - **Estado de Uso y Adopción:** Semáforo de los 12 módulos reales de GesPro (CRM, Cotizaciones, POS, CxC, Portal QR, CxP + IA, Inventario, Costos, Bancos, RRHH, Contabilidad, Reportes IA), tendencia semanal y monitor de usuarios clave con enlace directo a **Academia GesPro**.
  - **Salud Técnica y Bloqueos:** Disponibilidad, motor de BD, respaldos cifrados, ambiente `-TEST`, Puente SENIAT, tasa BCV, 2FA, gestor de bloqueos/acuerdos y bitácora cronológica.
  - **Todas las Empresas:** Portafolio comparativo multi-empresa con buscador, filtros de alerta y alta de nuevos clientes.
- **Reporte PDF ejecutivo:** Botón **Reporte PDF** con hoja de estilos optimizada para impresión (`@media print`).
- **Respaldo portátil:** Exportación e importación completa en JSON, más tema Claro / Oscuro.
- **Conexión en vivo opcional:** Botón **Conectar servidor GesPro** que consulta `GET /api/empresas?resumen=1` desde una instancia real de GesPro Administrativo mediante `servidor.mjs`.
