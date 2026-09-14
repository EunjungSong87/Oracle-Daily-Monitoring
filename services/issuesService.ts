import * as issuesModel from '../models/issuesModel';
import type { IssueRow, IssueDetail, IssueStatus } from '../models/issuesModel';

async function listIssues(statuses?: IssueStatus[]): Promise<IssueRow[]> {
  try {
    return await issuesModel.listIssues(statuses);
  } catch (error) {
    console.error('Service : 이슈 목록 조회 실패:', error);
    throw new Error('이슈 목록 조회 실패', { cause: error });
  }
}

async function getIssueDetail(id: number | string): Promise<IssueDetail | null> {
  try {
    return await issuesModel.getIssueDetail(id);
  } catch (error) {
    console.error('Service : 이슈 상세 조회 실패:', error);
    throw new Error('이슈 상세 조회 실패', { cause: error });
  }
}

async function acknowledgeIssue(id: number | string, assignee?: string): Promise<void> {
  try {
    await issuesModel.acknowledgeIssue(id, assignee);
  } catch (error) {
    console.error('Service : 이슈 확인 처리 실패:', error);
    throw new Error('이슈 확인 처리 실패', { cause: error });
  }
}

async function resolveIssue(id: number | string, resolvedBy?: string): Promise<void> {
  try {
    await issuesModel.resolveIssue(id, resolvedBy);
  } catch (error) {
    console.error('Service : 이슈 해결 처리 실패:', error);
    throw new Error('이슈 해결 처리 실패', { cause: error });
  }
}

async function reopenIssue(id: number | string, reopenedBy?: string): Promise<void> {
  try {
    await issuesModel.reopenIssue(id, reopenedBy);
  } catch (error) {
    console.error('Service : 이슈 재오픈 처리 실패:', error);
    throw new Error('이슈 재오픈 처리 실패', { cause: error });
  }
}

async function assignIssue(id: number | string, assignee: string): Promise<void> {
  try {
    await issuesModel.assignIssue(id, assignee);
  } catch (error) {
    console.error('Service : 담당자 지정 실패:', error);
    throw new Error('담당자 지정 실패', { cause: error });
  }
}

async function addComment(issueId: number | string, author: string | undefined, text: string): Promise<void> {
  try {
    await issuesModel.addComment(issueId, author, text);
  } catch (error) {
    console.error('Service : 댓글 등록 실패:', error);
    throw new Error('댓글 등록 실패', { cause: error });
  }
}

export { listIssues, getIssueDetail, acknowledgeIssue, resolveIssue, reopenIssue, assignIssue, addComment };
