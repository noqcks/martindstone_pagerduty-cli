/* eslint-disable no-await-in-loop */
/* eslint-disable complexity */
import Command from '../../base'
import {flags} from '@oclif/command'
import chalk from 'chalk'
import cli from 'cli-ux'
import * as utils from '../../utils'
import jp from 'jsonpath'
import * as chrono from 'chrono-node'

export default class IncidentList extends Command {
  static description = 'List PagerDuty Incidents'

  static flags = {
    ...Command.flags,
    me: flags.boolean({
      char: 'm',
      description: 'Return only incidents assigned to me',
      exclusive: ['assignees'],
    }),
    statuses: flags.string({
      char: 's',
      description: 'Return only incidents with the given statuses. Specify multiple times for multiple statuses.',
      multiple: true,
      options: ['open', 'closed', 'triggered', 'acknowledged', 'resolved'],
      default: ['open'],
    }),
    assignees: flags.string({
      char: 'e',
      description: 'Return only incidents assigned to this PD login email. Specify multiple times for multiple assignees.',
      multiple: true,
      exclusive: ['me'],
    }),
    teams: flags.string({
      char: 't',
      description: 'Team names to include. Specify multiple times for multiple teams.',
      multiple: true,
    }),
    services: flags.string({
      char: 'S',
      description: 'Service names to include. Specify multiple times for multiple services.',
      multiple: true,
    }),
    urgencies: flags.string({
      char: 'u',
      description: 'Urgencies to include.',
      multiple: true,
      options: ['high', 'low'],
      default: ['high', 'low'],
    }),
    since: flags.string({
      description: 'The start of the date range over which you want to search.',
    }),
    until: flags.string({
      description: 'The end of the date range over which you want to search.',
    }),
    keys: flags.string({
      char: 'k',
      description: 'Additional fields to display. Specify multiple times for multiple fields.',
      multiple: true,
    }),
    json: flags.boolean({
      char: 'j',
      description: 'output full details as JSON',
      exclusive: ['columns', 'filter', 'sort', 'csv', 'extended'],
    }),
    pipe: flags.boolean({
      char: 'p',
      description: 'Print incident ID\'s only to stdout, for use with pipes.',
      exclusive: ['columns', 'sort', 'csv', 'extended', 'json'],
    }),
    delimiter: flags.string({
      char: 'd',
      description: 'Delimiter for fields that have more than one value',
      default: '\n',
    }),
    ...cli.table.flags(),
  }

  async run() {
    const {flags} = this.parse(IncidentList)

    const statuses = [...new Set(flags.statuses)]
    if (statuses.indexOf('open') >= 0) {
      statuses.splice(statuses.indexOf('open'), 1, 'triggered', 'acknowledged')
    }
    if (statuses.indexOf('closed') >= 0) {
      statuses.splice(statuses.indexOf('closed'), 1, 'resolved')
    }
    const params: Record<string, any> = {
      statuses: [...new Set(statuses)],
    }

    if (flags.me) {
      const me = await this.me()
      params.user_ids = [me.user.id]
    }

    if (flags.urgencies) {
      params.urgencies = flags.urgencies
    }

    if (flags.assignees) {
      cli.action.start('Finding users')
      let users: any[] = []
      for (const email of flags.assignees) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.pd.fetch('users', {params: {query: email}})
        users = [...users, ...r.map((e: { id: any }) => e.id)]
      }
      const user_ids = [...new Set(users)]
      if (user_ids.length === 0) {
        cli.action.stop(chalk.bold.red('none found'))
        this.error('No assignee user IDs found. Please check your search.', {exit: 1})
      }
      params.user_ids = user_ids
    }

    if (flags.teams) {
      cli.action.start('Finding teams')
      let teams: any[] = []
      for (const name of flags.teams) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.pd.fetch('teams', {params: {query: name}})
        teams = [...teams, ...r.map((e: { id: any }) => e.id)]
      }
      const team_ids = [...new Set(teams)]
      if (team_ids.length === 0) {
        cli.action.stop(chalk.bold.red('none found'))
        this.error('No teams found. Please check your search.', {exit: 1})
      }
      params.team_ids = team_ids
    }

    if (flags.services) {
      cli.action.start('Finding services')
      let services: any[] = []
      for (const name of flags.services) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.pd.fetch('services', {params: {query: name}})
        services = [...services, ...r.map((e: { id: any }) => e.id)]
      }
      const service_ids = [...new Set(services)]
      if (service_ids.length === 0) {
        cli.action.stop(chalk.bold.red('none found'))
        this.error('No services found. Please check your search.', {exit: 1})
      }
      params.service_ids = service_ids
    }

    if (flags.since) {
      const since = chrono.parseDate(flags.since)
      if (since) {
        params.since = since.toISOString()
      }
    }
    if (flags.until) {
      const until = chrono.parseDate(flags.until)
      if (until) {
        params.until = until.toISOString()
      }
    }

    cli.action.start('Getting incident priorities from PD')
    const priorities_map = await this.pd.getPrioritiesMapByID()
    if (priorities_map === {}) {
      cli.action.stop(chalk.bold.red('none found'))
    }

    const incidents = await this.pd.fetchWithSpinner('incidents', {
      params: params,
      activityDescription: 'Getting incidents',
    })

    if (incidents.length === 0) {
      this.error('No incidents found', {exit: 0})
    }

    if (flags.json) {
      await utils.printJsonAndExit(incidents)
    }

    const columns: Record<string, object> = {
      id: {
        header: 'ID',
      },
      incident_number: {
        header: '#',
      },
      status: {
        get: (row: {status: string}) => {
          switch (row.status) {
          case 'triggered':
            return chalk.bold.red(row.status)
          case 'acknowledged':
            return chalk.bold.keyword('orange')(row.status)
          case 'resolved':
            return chalk.bold.green(row.status)
          default:
            return row.status
          }
        },
      },
      priority: {
        get: (row: { priority: { summary: string; id: string } }) => {
          if (row.priority && row.priority.summary && row.priority.id) {
            if (priorities_map[row.priority.id]) {
              return chalk.bold.hex(priorities_map[row.priority.id].color)(row.priority.summary)
            }
            return row.priority.summary
          }
          return ''
        },
      },
      urgency: {
        get: (row: { urgency: string }) => {
          if (row.urgency === 'high') {
            return chalk.bold(row.urgency)
          }
          return row.urgency
        },
      },
      title: {
      },
      created: {
        get: (row: { created_at: string }) => (new Date(row.created_at)).toLocaleString(),
      },
      service: {
        get: (row: { service: {summary: string}}) => row.service.summary,
      },
      assigned_to: {
        get: (row: {assignments: any[]}) => {
          if (row.assignments && row.assignments.length > 0) {
            return row.assignments.map(e => e.assignee.summary).join(flags.delimiter)
          }
          return ''
        },
      },
      teams: {
        get: (row: {teams: any[]}) => {
          if (row.teams && row.teams.length > 0) {
            return row.teams.map(e => e.summary).join(flags.delimiter)
          }
          return ''
        },
      },
      html_url: {
        header: 'URL',
        extended: true,
      },
    }

    if (flags.keys) {
      for (const key of flags.keys) {
        columns[key] = {
          header: key,
          get: (row: any) => utils.formatField(jp.query(row, key), flags.delimiter),
        }
      }
    }

    const options = {
      printLine: this.log,
      ...flags, // parsed flags
    }

    if (flags.pipe) {
      for (const k of Object.keys(columns)) {
        if (k !== 'id') {
          const colAny = columns[k] as any
          colAny.extended = true
        }
      }
      options['no-header'] = true
    }

    cli.table(incidents, columns, options)
  }
}
