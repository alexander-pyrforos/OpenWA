import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Edit, FileText, Loader2, Plus, Trash2, X } from 'lucide-react';
import { type MessageTemplate, type TemplatePayload } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useCreateTemplateMutation,
  useDeleteTemplateMutation,
  useSessionsQuery,
  useTemplatesQuery,
  useUpdateTemplateMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { copyToClipboard } from '../utils/clipboard';
import './Templates.css';

type TemplateForm = {
  name: string;
  header: string;
  body: string;
  footer: string;
};

const emptyForm: TemplateForm = {
  name: '',
  header: '',
  body: '',
  footer: '',
};

function extractPlaceholders(template: TemplateForm | MessageTemplate) {
  const source = [template.header, template.body, template.footer].filter(Boolean).join('\n');
  return Array.from(new Set(Array.from(source.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g), match => match[1]))).sort();
}

function toPayload(form: TemplateForm): TemplatePayload {
  return {
    name: form.name.trim(),
    header: form.header.trim() || null,
    body: form.body.trim(),
    footer: form.footer.trim() || null,
  };
}

function renderPreview(template: TemplateForm, values: Record<string, string>) {
  return [template.header, template.body, template.footer]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] || `{{${key}}}`);
}

export function Templates() {
  const { t } = useTranslation();
  useDocumentTitle(t('templates.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});

  const { data: templates = [], isLoading: loadingTemplates } = useTemplatesQuery(selectedSessionId, !!selectedSessionId);
  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const placeholders = useMemo(() => extractPlaceholders(form), [form]);
  const preview = useMemo(() => renderPreview(form, previewValues), [form, previewValues]);
  const isSaving = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setPreviewValues(current => {
      const next: Record<string, string> = {};
      for (const key of placeholders) {
        next[key] = current[key] || '';
      }
      return next;
    });
  }, [placeholders]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTemplate(null);
    setPreviewValues({});
  };

  const openEdit = (template: MessageTemplate) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      header: template.header || '',
      body: template.body,
      footer: template.footer || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSave = async () => {
    if (!selectedSessionId || !form.name.trim() || !form.body.trim()) return;

    try {
      if (editingTemplate) {
        await updateMutation.mutateAsync({
          sessionId: selectedSessionId,
          id: editingTemplate.id,
          data: toPayload(form),
        });
        setToast({ type: 'success', message: t('templates.toasts.updated') });
      } else {
        await createMutation.mutateAsync({
          sessionId: selectedSessionId,
          data: toPayload(form),
        });
        setToast({ type: 'success', message: t('templates.toasts.created') });
      }
      resetForm();
    } catch (err) {
      setToast({
        type: 'error',
        message: t(editingTemplate ? 'templates.toasts.updateFailed' : 'templates.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId || !deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      setToast({ type: 'success', message: t('templates.toasts.deleted') });
      if (editingTemplate?.id === deleteTarget.id) resetForm();
      setDeleteTarget(null);
    } catch (err) {
      setToast({
        type: 'error',
        message: t('templates.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const copyName = async (name: string) => {
    if (await copyToClipboard(name)) {
      setToast({ type: 'success', message: t('templates.toasts.copied') });
    }
  };

  if (loadingSessions) {
    return (
      <div className="templates-page templates-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="templates-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('templates.title')}
        subtitle={t('templates.subtitle')}
        actions={
          <select
            className="templates-session-select"
            value={selectedSessionId}
            onChange={event => {
              setSelectedSessionId(event.target.value);
              resetForm();
            }}
          >
            {sessions.length === 0 && <option value="">{t('templates.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {sessions.length === 0 ? (
        <div className="templates-empty-page">
          <FileText size={48} strokeWidth={1} />
          <h3>{t('templates.empty.noSessionsTitle')}</h3>
          <p>{t('templates.empty.noSessionsDesc')}</p>
        </div>
      ) : (
        <div className="templates-grid">
          <section className="template-editor">
            <div className="template-editor-header">
              <div>
                <h2>{editingTemplate ? t('templates.editTitle') : t('templates.createTitle')}</h2>
                <p>{selectedSession ? t('templates.sessionHint', { name: selectedSession.name }) : ''}</p>
              </div>
              {editingTemplate && (
                <button className="btn-secondary" onClick={resetForm}>
                  {t('templates.newTemplate')}
                </button>
              )}
            </div>

            <div className="template-form">
              <div className="form-group">
                <label>{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder={t('templates.namePlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="form-group">
                <label>{t('templates.header')}</label>
                <input
                  value={form.header}
                  onChange={event => setForm({ ...form, header: event.target.value })}
                  placeholder={t('templates.headerPlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="form-group">
                <label>{t('templates.body')}</label>
                <textarea
                  value={form.body}
                  onChange={event => setForm({ ...form, body: event.target.value })}
                  placeholder={t('templates.bodyPlaceholder')}
                  rows={8}
                  disabled={!canWrite}
                />
              </div>

              <div className="form-group">
                <label>{t('templates.footer')}</label>
                <input
                  value={form.footer}
                  onChange={event => setForm({ ...form, footer: event.target.value })}
                  placeholder={t('templates.footerPlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="template-editor-actions">
                <button className="btn-secondary" onClick={resetForm} disabled={isSaving}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={!canWrite || isSaving || !selectedSessionId || !form.name.trim() || !form.body.trim()}
                >
                  {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  {canWrite ? t(editingTemplate ? 'templates.saveChanges' : 'templates.createTemplate') : t('templates.viewOnly')}
                </button>
              </div>
            </div>
          </section>

          <aside className="template-preview">
            <h2>{t('templates.previewTitle')}</h2>
            {placeholders.length > 0 ? (
              <div className="placeholder-list">
                {placeholders.map(key => (
                  <label key={key}>
                    <span>{`{{${key}}}`}</span>
                    <input
                      value={previewValues[key] || ''}
                      onChange={event => setPreviewValues({ ...previewValues, [key]: event.target.value })}
                      placeholder={t('templates.previewValuePlaceholder')}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="template-muted">{t('templates.noPlaceholders')}</p>
            )}
            <pre className="template-preview-box">{preview || t('templates.previewEmpty')}</pre>
          </aside>

          <section className="templates-list">
            <div className="templates-list-header">
              <h2>{t('templates.savedTitle')}</h2>
              <span>{t('templates.count', { count: templates.length })}</span>
            </div>

            {loadingTemplates ? (
              <div className="templates-loading-inline">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : templates.length === 0 ? (
              <div className="templates-empty-list">
                <FileText size={40} strokeWidth={1} />
                <h3>{t('templates.empty.title')}</h3>
                <p>{t('templates.empty.description')}</p>
              </div>
            ) : (
              <div className="template-card-list">
                {templates.map(template => {
                  const templatePlaceholders = extractPlaceholders(template);
                  return (
                    <article key={template.id} className="template-card">
                      <div className="template-card-main">
                        <div className="template-card-title-row">
                          <h3>{template.name}</h3>
                          <button
                            className="icon-btn"
                            title={t('templates.actions.copyName')}
                            onClick={() => void copyName(template.name)}
                          >
                            <Copy size={16} />
                          </button>
                        </div>
                        <p>{template.body}</p>
                        {templatePlaceholders.length > 0 && (
                          <div className="template-placeholder-tags">
                            {templatePlaceholders.map(key => (
                              <span key={key}>{`{{${key}}}`}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="template-card-actions">
                        <button className="icon-btn" title={t('common.edit')} onClick={() => openEdit(template)}>
                          <Edit size={16} />
                        </button>
                        {canWrite && (
                          <button
                            className="icon-btn danger"
                            title={t('common.delete')}
                            onClick={() => setDeleteTarget(template)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('templates.deleteTitle')}</h2>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('templates.deleteConfirm', { name: deleteTarget.name })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
